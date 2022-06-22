import { useState, useEffect } from "react";
import { customAlphabet } from "nanoid";
import _ from "lodash";
import { TypedEventEmitter } from "../lib";
import { Json, PresenceUpdates, PresenceUpsert } from "../types";

const nanoid = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  8
);

type ClientId = string;
type PresenceMap = Map<ClientId, Json>;

class SseProvider extends TypedEventEmitter<{
  load: (msg: string) => void;
  update: (msg: string) => void;
}> {
  eventSource: EventSource;
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
    this.eventSource.close();
  }
}

class PresenceProvider extends TypedEventEmitter<{
  update: (presenceMap: PresenceMap) => void;
}> {
  private states: PresenceMap;
  private sseProvider: SseProvider;
  public clientId: string = nanoid();

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
    this.sseProvider.destroy();
    super.off();
  }
}

const deduplicate = (rows: { serialId; entityId }[]) =>
  _.chain(rows)
    .groupBy((row) => row.entityId)
    .entries()
    .map(([, rows]) => _.maxBy(rows, (row) => row.serialId))
    .value();

const baseUrl = "https://localhost:8000";

const channelName = "chan1";

const PresenceView = () => {
  const [presenceMap, setPresenceMap] = useState<Record<string, unknown>>();

  useEffect(() => {
    const provider = new PresenceProvider(
      `${baseUrl}/presence/${channelName}/get`,
      `${baseUrl}/presence/${channelName}/pub`,
      `${baseUrl}/presence/${channelName}/sub`
    );

    provider.on("update", (map) =>
      setPresenceMap(Object.fromEntries(map.entries()))
    );

    provider.init();

    const handler = (e: MouseEvent) => {
      provider.setLocalState({ x: e.clientX, y: e.clientY });
    };

    document.addEventListener("mousemove", handler);

    return () => {
      provider.destroy();
      document.removeEventListener("mousemove", handler);
    };
  }, []);

  return <pre>{JSON.stringify(presenceMap, null, 2)}</pre>;
};

const EntityView = () => {
  const [entities, setEntities] = useState([]);

  useEffect(() => {
    const baseUrl = "https://localhost:8000";

    const provider = new SseProvider(
      `${baseUrl}/channel/${channelName}/get`,
      `${baseUrl}/channel/${channelName}/sub`
    );

    provider.on("update", (msg) =>
      setEntities((messages) => deduplicate([...messages, ...JSON.parse(msg)]))
    );

    provider.on("load", (msg) => setEntities(JSON.parse(msg)));

    provider.init();

    return () => provider.destroy();
  }, []);

  return (
    <div>
      {entities.map((entity) => (
        <div key={entity.entityId}>
          {entity.data.text}
          <button
            onClick={async () => {
              await fetch(`${baseUrl}/channel/${channelName}/pub`, {
                method: "post",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  entityType: "chatMessage",
                  entityId: entity.entityId,
                  data: { text: `Hello, world! ${Math.random()}` },
                }),
              });
            }}
          >
            Update
          </button>
        </div>
      ))}

      <button
        onClick={async () => {
          await fetch(`${baseUrl}/channel/${channelName}/pub`, {
            method: "post",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              entityType: "chatMessage",
              entityId: nanoid(),
              data: { text: `Hello, world! ${Math.random()}` },
            }),
          });
        }}
      >
        Send
      </button>
    </div>
  );
};

export default function Page() {
  return (
    <>
      <PresenceView />
      <EntityView />
    </>
  );
}
