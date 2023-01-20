import { createId } from "@workspace/common/id";
import { TypedEventEmitter } from "@workspace/common/typed-event-emitter";
import { Json, PresenceUpdates, PresenceUpsert } from "@workspace/common/types";

export class SseProvider extends TypedEventEmitter<{
  load: (msg: string) => void;
  update: (msg: string) => void;
}> {
  private initState: { eventSource: EventSource } | undefined = undefined;
  constructor(public getUrl: string, public sseUrl: string) {
    super();
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

type ClientId = string;
type PresenceMap = Map<ClientId, Json>;

export class PresenceProvider extends TypedEventEmitter<{
  update: () => void;
}> {
  private channelId: string;
  private getUrl: string;
  private pubUrl: string;
  private subUrl: string;

  private initState: { sseProvider: SseProvider } | undefined = undefined;

  public states: PresenceMap = new Map();
  public clientId: string = createId();

  constructor({ host, channelId }: { host: string; channelId: string }) {
    console.debug("Presence init");

    super();

    this.channelId = channelId;
    this.getUrl = `${host}/presence/get?channelId=${channelId}`;
    this.pubUrl = `${host}/presence/pub?channelId=${channelId}`;
    this.subUrl = `${host}/presence/sub?channelId=${channelId}&clientId=${this.clientId}`;
  }

  public init() {
    if (this.initState) throw new Error("IllegalStateException");

    const sseProvider = new SseProvider(this.getUrl, this.subUrl);
    sseProvider.on("load", this.onLoad.bind(this));
    sseProvider.on("update", this.onUpdate.bind(this));
    sseProvider.init();

    this.initState = { sseProvider };

    this.setLocalState({ timeJoined: new Date().toISOString() });
  }

  private onLoad(msg: string) {
    this.states.clear();
    this.onUpdate(msg);
  }

  private onUpdate(msg: string) {
    if (!this.initState) throw new Error("IllegalStateException");

    const updates = PresenceUpdates.parse(JSON.parse(msg));

    for (const update of updates) {
      if (update.type === "upsert") {
        this.states.set(update.clientId, update.data);
      } else {
        this.states.delete(update.clientId);
      }
    }

    this.emit("update");
  }

  public async setLocalState(data: PresenceUpsert["data"]) {
    await fetch(this.pubUrl, {
      method: "post",
      body: JSON.stringify({
        type: "upsert",
        clientId: this.clientId,
        channelId: this.channelId,
        data,
      }),
    });
  }

  public getLocalState(): PresenceUpsert["data"] | undefined {
    if (!this.initState) throw new Error("IllegalStateException");
    return this.states.get(this.clientId);
  }

  public destroy() {
    console.debug("Presence destroy");
    if (!this.initState) throw new Error("IllegalStateException");
    super.off();
    this.initState.sseProvider.destroy();
    this.initState = undefined;
  }
}
