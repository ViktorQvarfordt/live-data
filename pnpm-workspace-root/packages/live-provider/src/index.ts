import { createId } from "@workspace/common/id";
import { TypedEventEmitter } from "@workspace/common/typed-event-emitter";
import { Json, PresenceUpdates, RedisMessage } from "@workspace/common/types";

class Ticker {
  private initState: { timeout?: ReturnType<typeof setTimeout> } | undefined =
    undefined;

  /**
   * Calls `callback` after at least `delayMs`. Never calls `callback` parallel.
   */
  public init(
    callback: () => void | Promise<void>,
    delayMs: number,
    runImmediately: boolean
  ) {
    if (this.initState) throw new Error("IllegalStateException");

    const handler = async () => {
      if (!this.initState) throw new Error("IllegalStateException");

      const t0 = performance.now();
      await callback();
      const t1 = performance.now();
      const dt = t1 - t0;

      this.initState.timeout = setTimeout(handler, delayMs - dt);
    };

    this.initState = {};

    if (runImmediately) {
      handler();
    } else {
      this.initState.timeout = setTimeout(handler, delayMs);
    }
  }

  public reset() {
    // TODO
  }

  public destroy() {
    if (!this.initState) throw new Error("IllegalStateException");
    clearTimeout(this.initState.timeout);
    this.initState = undefined;
  }
}

type ClientId = string;

export class SseProvider extends TypedEventEmitter<{
  load: (msg: string) => void;
  update: (msg: string) => void;
}> {
  public clientId: string;
  private initState: { eventSource: EventSource } | undefined = undefined;

  private getUrl: string;
  private sseUrl: string;

  constructor({
    getUrl,
    sseUrl,
    clientId,
  }: {
    getUrl: string;
    sseUrl: string;
    clientId?: ClientId;
  }) {
    super();

    this.clientId = clientId ?? createId();
    this.getUrl = getUrl;
    this.sseUrl = `${sseUrl}&clientId=${this.clientId}`;
  }

  public init() {
    if (this.initState) throw new Error("IllegalStateException");

    const eventSource = new EventSource(this.sseUrl);

    eventSource.addEventListener("message", (event) => {
      const msg = event.data;
      console.debug("EntityProvider eventSource message", msg);
      this.emit("update", msg);
    });

    eventSource.addEventListener("error", () => {
      console.error("EntityProvider eventSource error");
    });

    // Called when eventSource first opens and when recovering from error.
    eventSource.addEventListener("open", () => {
      console.debug("EntityProvider eventSource open");
      this.get();
    });

    this.initState = { eventSource };
  }

  private async get() {
    const result = await fetch(this.getUrl);
    const msg = await result.text();
    this.emit("load", msg);
  }

  public destroy() {
    console.debug("Provider destroy");
    if (!this.initState) throw new Error("IllegalStateException");
    super.off();
    this.initState.eventSource.close();
    this.initState = undefined;
  }
}

type PresenceMap = Map<ClientId, Json>;

export class PresenceProvider extends TypedEventEmitter<{
  update: () => void;
}> {
  private channelId: string;
  private getUrl: string;
  private pubUrl: string;
  private subUrl: string;
  private heartbeatUrl: string;

  private initState: { sseProvider: SseProvider; ticker: Ticker } | undefined =
    undefined;

  public states: PresenceMap = new Map();
  public localState: Json | undefined = undefined;
  public clientId = createId();

  constructor({ host, channelId }: { host: string; channelId: string }) {
    console.debug("Presence init");

    super();

    this.channelId = channelId;
    this.getUrl = `${host}/presence/get?channelId=${channelId}`;
    this.pubUrl = `${host}/presence/pub?channelId=${channelId}`;
    this.subUrl = `${host}/presence/sub?channelId=${channelId}`;
    this.heartbeatUrl = `${host}/presence/heartbeat?channelId=${channelId}&clientId=${this.clientId}`;
  }

  public init(initialLocalsState?: Json) {
    if (this.initState) throw new Error("IllegalStateException");

    // TODO Consider letting PresenceProvider implement it's own eventSource and not use SseProvider since they both want control of clientId etc. It gets awkward using SeeProvider when implementing PresenceProvider
    const sseProvider = new SseProvider({
      getUrl: this.getUrl,
      sseUrl: this.subUrl,
      clientId: this.clientId
    });
    sseProvider.on("load", this.onLoad.bind(this));
    sseProvider.on("update", this.onUpdate.bind(this));
    sseProvider.init();

    const ticker = new Ticker();

    ticker.init(this.sendHeartbeat.bind(this), 5000, false);

    this.initState = { sseProvider, ticker };

    this.updateLocalState(initialLocalsState ?? null);
  }

  private async sendHeartbeat() {
    if (!this.initState) throw new Error("IllegalStateException");

    await fetch(this.heartbeatUrl, {
      method: "post",
      body: JSON.stringify({
        clientId: this.clientId,
        channelId: this.channelId,
      }),
    });
  }

  private onLoad(msg: string) {
    if (!this.initState) throw new Error("IllegalStateException");

    this.states.clear();

    this.handleUpdates(PresenceUpdates.parse(JSON.parse(msg)));
  }

  private onUpdate(msg: string) {
    if (!this.initState) throw new Error("IllegalStateException");

    this.handleUpdates(
      PresenceUpdates.parse(RedisMessage.parse(JSON.parse(msg)).domainMessages)
    );
  }

  private handleUpdates(updates: PresenceUpdates) {
    if (!this.initState) throw new Error("IllegalStateException");

    for (const update of updates) {
      if (update.type === "upsert") {
        this.states.set(update.clientId, update.data);
      } else if (update.type === "delete") {
        this.states.delete(update.clientId);
      } else {
        // TODO Make typesafe exhaustive check
        // isOfType<never>(update)
      }
    }

    this.emit("update");
  }

  public async updateLocalState(data: Json) {
    if (!this.initState) throw new Error("IllegalStateException");

    this.states.set(this.clientId, data);
    this.emit("update");

    await fetch(this.pubUrl, {
      method: "post",
      body: JSON.stringify({
        type: "upsert",
        clientId: this.clientId,
        channelId: this.channelId,
        data,
      }),
    });

    this.initState.ticker.reset()
  }

  public getLocalState(): Json | undefined {
    if (!this.initState) throw new Error("IllegalStateException");
    return this.states.get(this.clientId);
  }

  public destroy() {
    console.debug("Presence destroy");
    if (!this.initState) throw new Error("IllegalStateException");
    super.off();
    this.initState.sseProvider.destroy();
    this.initState.ticker.destroy();
    this.initState = undefined;
  }
}
