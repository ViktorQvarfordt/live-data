import http2 from "node:http2";
import fs from "node:fs";
import { createClient } from "redis";
import * as db from "./db";

type ChannelName = string;

export class Replicator {
  activeStreams = new Map<ChannelName, Set<http2.ServerHttp2Stream>>();
  redisChannels = new Set<ChannelName>();
  redisClient = createClient();
  redisSubscriber = this.redisClient.duplicate();
  state: "uninitialized" | "initializing" | "initialized" = "uninitialized";

  async init() {
    if (this.state !== "uninitialized") {
      throw new Error("init() already called");
    }
    this.state = "initializing";

    this.redisClient.on("error", (err) =>
      console.log("Redis Client Error", err)
    );
    await this.redisClient.connect();
    this.redisSubscriber = this.redisClient.duplicate();
    await this.redisSubscriber.connect();

    this.state = "initialized";
  }

  async subscribe(
    channelName: ChannelName,
    stream: http2.ServerHttp2Stream
  ): Promise<void> {
    if (this.state !== "initialized") {
      throw new Error("Not initialized, call init() first");
    }
    console.log("subscribe", channelName);

    if (!this.activeStreams.has(channelName)) {
      this.activeStreams.set(channelName, new Set());
    }

    this.activeStreams.get(channelName)?.add(stream);

    if (!this.redisChannels.has(channelName)) {
      console.log("redis subscribe", channelName);
      this.redisChannels.add(channelName);

      await this.redisSubscriber.subscribe(channelName, (message) => {
        console.log("redis got message", channelName, message);
        this.activeStreams.get(channelName)?.forEach((stream) => {
          stream.write(`data: ${message}\n\n`);
        });
      });
    }
  }

  async unsubscribe(
    channelName: ChannelName,
    stream: http2.ServerHttp2Stream
  ): Promise<void> {
    if (this.state !== "initialized") {
      throw new Error("Not initialized, call init() first");
    }
    console.log("unsubscribe", channelName);

    const set = this.activeStreams.get(channelName);
    if (set) {
      set.delete(stream);

      if (set.size === 0) {
        this.activeStreams.delete(channelName);
      }
    }

    if (this.redisChannels.has(channelName)) {
      console.log("redis unsubscribe", channelName);

      this.redisChannels.delete(channelName);
      await this.redisSubscriber.unsubscribe(channelName);
    }
  }

  async publish(channelName: ChannelName, data: string): Promise<void> {
    if (this.state !== "initialized") {
      throw new Error("Not initialized, call init() first");
    }

    console.log(
      `publish on ${channelName} to ${
        this.activeStreams.get(channelName)?.size
      } clients:`,
      data
    );

    await this.redisClient.publish(channelName, data);
  }
}
