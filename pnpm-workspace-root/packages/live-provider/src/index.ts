import { mkId } from "@workspace/common/id";
import { TypedEventEmitter } from "@workspace/common/typed-event-emitter";
import { Json, PresenceUpdates, PresenceUpsert } from "@workspace/common/types";

export class SseProvider extends TypedEventEmitter<{
  load: (msg: string) => void;
  update: (msg: string) => void;
}> {
  eventSource: EventSource | undefined = undefined;
  state: "uninitialized" | "initializing" | "initialized" = "uninitialized";

  constructor(public getUrl: string, public sseUrl: string) {
    super();
  }

  init() {
    if (this.state !== "uninitialized") {
      throw new Error("init() already called");
    }
    this.state = "initializing";

    this.eventSource = new EventSource(this.sseUrl);

    this.eventSource.addEventListener("message", (event) => {
      const msg = event.data;
      console.debug("EntityProvider eventSource message", msg);
      this.emit("update", msg);
    });

    this.eventSource.addEventListener("error", () => {
      console.error("EntityProvider eventSource error");
    });

    // Called when eventSource first opens and when recovering from error.
    this.eventSource.addEventListener("open", () => {
      console.debug("EntityProvider eventSource open");
      this.get();
    });

    this.state = "initialized";
  }

  private async get() {
    const result = await fetch(this.getUrl);
    const msg = await result.text();
    this.emit("load", msg);
  }

  destroy() {
    console.debug("Provider destroy");
    super.off();
    this.eventSource?.close();
  }
}

type ClientId = string;
type PresenceMap = Map<ClientId, Json>;

export class PresenceProvider extends TypedEventEmitter<{
  update: (presenceMap: PresenceMap) => void;
}> {
  private states: PresenceMap;
  private sseProvider: SseProvider | undefined = undefined;
  public clientId: string = mkId();

  constructor(
    private getUrl: string,
    private pubUrl: string,
    private subUrl: string
  ) {
    super();
    console.debug("Presence init");

    this.states = new Map();
  }

  init() {
    this.sseProvider = new SseProvider(
      this.getUrl,
      `${this.subUrl}/${this.clientId}`
    );
    this.sseProvider.on("load", this.onLoad.bind(this));
    this.sseProvider.on("update", this.onUpdate.bind(this));
    this.sseProvider.init();

    this.setLocalState({ timeJoined: new Date().toISOString() });
  }

  private onLoad(msg: string) {
    this.states.clear();
    this.onUpdate(msg);
  }

  private onUpdate(msg: string) {
    const updates = PresenceUpdates.parse(JSON.parse(msg));

    for (const update of updates) {
      if (update.type === "upsert") {
        this.states.set(update.clientId, update.data);
      } else {
        this.states.delete(update.clientId);
      }
    }

    this.emit("update", this.states);
  }

  async setLocalState(data: PresenceUpsert["data"]) {
    await fetch(this.pubUrl, {
      method: "post",
      body: JSON.stringify({ type: "upsert", clientId: this.clientId, data }),
    });
  }

  getLocalState(): PresenceUpsert["data"] | undefined {
    return this.states.get(this.clientId);
  }

  destroy() {
    console.debug("Presence destroy");
    this.sseProvider?.destroy();
    super.off();
  }
}
