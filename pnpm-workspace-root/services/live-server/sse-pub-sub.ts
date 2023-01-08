import { ServerHttp2Stream } from "node:http2";
import { redisClient } from "./redis.js";

type ChannelName = string;

export class SsePubSub {
  activeChannels = new Map<ChannelName, Set<ServerHttp2Stream>>();
  redisSubscriber: ReturnType<typeof redisClient.duplicate> = redisClient.duplicate();
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

  async subscribe(
    channelName: ChannelName,
    stream: ServerHttp2Stream
  ): Promise<void> {
    if (this.state !== "initialized") {
      throw new Error("Not initialized, call init() first");
    }
    console.log("subscribe", channelName);

    if (!this.activeChannels.has(channelName)) {
      console.log('open channel')

      this.activeChannels.set(channelName, new Set());

      await this.redisSubscriber.subscribe(channelName, (message) => {
        const count = this.activeChannels.get(channelName)?.size;
        console.log(`redis receive on ${channelName}, publishing to ${count} clients`);

        this.activeChannels.get(channelName)?.forEach((stream) => {
          stream.write(`data: ${message}\n\n`);
        });
      });
    }

    this.activeChannels.get(channelName)?.add(stream);
  }

  async unsubscribe(
    channelName: ChannelName,
    stream: ServerHttp2Stream
  ): Promise<void> {
    if (this.state !== "initialized") {
      throw new Error("Not initialized, call init() first");
    }
    console.log("unsubscribe", channelName);

    const set = this.activeChannels.get(channelName);
    if (set) {
      set.delete(stream);

      if (set.size === 0) {
        console.log("release channel", channelName);
        this.activeChannels.delete(channelName);
        await this.redisSubscriber.unsubscribe(channelName);
      }
    }
  }

  async publish(channelName: ChannelName, data: string): Promise<void> {
    if (this.state !== "initialized") {
      throw new Error("Not initialized, call init() first");
    }

    console.log(`redis publish on ${channelName}`);

    await redisClient.publish(channelName, data);
  }
}
