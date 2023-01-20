import { ServerHttp2Stream } from "node:http2";
import { redisClient } from "./redis.js";
import { z } from "zod";
import { Json, RedisMessage } from "@workspace/common/types";
import { asNonNullable } from "@workspace/common/assert";

type Channel = `presence:${string}` | `channel:${string}`;

type ClientId = string;

export class SsePubSub {
  activeChannelStreams = new Map<Channel, Map<ClientId, ServerHttp2Stream>>();
  redisSubscriber: ReturnType<typeof redisClient.duplicate> =
    redisClient.duplicate();
  state: "uninitialized" | "initializing" | "initialized" = "uninitialized";

  async init() {
    if (this.state !== "uninitialized") {
      throw new Error("init() already called");
    }
    this.state = "initializing";

    this.redisSubscriber = redisClient.duplicate();
    await this.redisSubscriber.connect();

    this.state = "initialized";
  }

  async subscribe({
    channel,
    clientId,
    stream,
  }: {
    channel: Channel;
    clientId: string;
    stream: ServerHttp2Stream;
  }): Promise<void> {
    if (this.state !== "initialized") {
      throw new Error("Not initialized, call init() first");
    }

    if (!this.activeChannelStreams.has(channel)) {
      console.log(`SSE ope ${channel} ${clientId}`);

      this.activeChannelStreams.set(channel, new Map());

      await this.redisSubscriber.subscribe(channel, (redisMessage) => {
        const count = this.activeChannelStreams.get(channel)?.size;
        console.log(
          `SSE rcv ${channel} ${count}`
        );

        this.activeChannelStreams.get(channel)?.forEach((stream, clientId) => {
          const parsedMessage = RedisMessage.parse(JSON.parse(redisMessage));
          // Prevent echo
          if (parsedMessage.clientId !== clientId) {
            stream.write(`data: ${redisMessage}\n\n`);
          }
        });
      });
    }

    console.log(`SSE sub ${channel} ${clientId}`);

    asNonNullable(this.activeChannelStreams.get(channel)).set(clientId, stream);
  }

  async unsubscribe({
    channel,
    clientId,
  }: {
    channel: Channel;
    clientId: string;
  }): Promise<void> {
    if (this.state !== "initialized") {
      throw new Error("Not initialized, call init() first");
    }
    console.log("unsubscribe", channel);

    const clientMap = this.activeChannelStreams.get(channel);
    if (clientMap) {
      clientMap.delete(clientId);

      if (clientMap.size === 0) {
        console.log("release channel", channel);
        this.activeChannelStreams.delete(channel);
        await this.redisSubscriber.unsubscribe(channel);
      }
    }
  }

  async publish(channel: Channel, data: RedisMessage): Promise<void> {
    if (this.state !== "initialized") {
      throw new Error("Not initialized, call init() first");
    }

    console.log(`SSE pub ${channel} ${data.clientId}`);

    await redisClient.publish(channel, JSON.stringify(data));
  }
}
