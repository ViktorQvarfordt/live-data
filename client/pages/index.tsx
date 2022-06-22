import { useState, useEffect, useRef } from "react";
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

const normalize = (rows: { messageSequenceId; messageId, isDeleted }[]) =>
  _.chain(rows)
    .groupBy((row) => row.messageId)
    .entries()
    .map(([, rows]) => _.maxBy(rows, (row) => row.messageSequenceId))
    .filter(row => !row.isDeleted)
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

    // const handler = (e: MouseEvent) => {
    //   provider.setLocalState({ x: e.clientX, y: e.clientY });
    // };

    // document.addEventListener("mousemove", handler);

    return () => {
      provider.destroy();
      // document.removeEventListener("mousemove", handler);
    };
  }, []);

  return <pre>{JSON.stringify(presenceMap, null, 2)}</pre>;
};

const useEntities = () => {
  const [entities, setEntities] = useState([]);

  useEffect(() => {
    const baseUrl = "https://localhost:8000";

    const provider = new SseProvider(
      `${baseUrl}/channel/${channelName}/get`,
      `${baseUrl}/channel/${channelName}/sub`
    );

    provider.on("update", (msg) =>
      setEntities((messages) => normalize([...messages, ...JSON.parse(msg)]))
    );

    provider.on("load", (msg) => setEntities(normalize(JSON.parse(msg))));

    provider.init();

    return () => provider.destroy();
  }, []);

  return entities;
};

const useChatMessages = () => {
  const [chatMessages, setChatMessages] = useState([]);

  useEffect(() => {
    const baseUrl = "https://localhost:8000";

    const provider = new SseProvider(
      `${baseUrl}/chat/${channelName}/get`,
      `${baseUrl}/channel/${channelName}/sub`
    );

    provider.on("update", (msg) =>
      setChatMessages((messages) => {
        console.log([...messages, ...JSON.parse(msg)]);
        return normalize([...messages, ...JSON.parse(msg)]);
      })
    );

    provider.on("load", (msg) => setChatMessages(normalize(JSON.parse(msg))));

    provider.init();

    return () => provider.destroy();
  }, []);

  return chatMessages;
};

const upsertMessage = async (
  chatId: string,
  messageId: string,
  text?: string,
  isDeleted?: boolean
) => {
  await fetch(`${baseUrl}/chat/upsert`, {
    method: "post",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatId, messageId, text, isDeleted }),
  });
};

const Message = ({ message }) => {
  // const [isEditing, setIsEditing] = useState(false);
  const [text, setText] = useState(message.text ?? "");
  const inputRef = useRef<HTMLInputElement>();

  useEffect(() => {
    setText(message.text ?? '');
    inputRef.current?.blur();
  }, [message.text]);

  return (
    <div>
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          upsertMessage(message.chatId, message.messageId, text);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            upsertMessage(message.chatId, message.messageId, text);
            (e.target as HTMLInputElement)?.blur();
          }
          if (e.key === "Escape") {
            (e.target as HTMLInputElement)?.blur();
          }
          if (e.key === "Backspace" && text === '') {
            upsertMessage(message.chatId, message.messageId, undefined, true);
          }
        }}
      />
    </div>
  );
};

const ChatView = () => {
  const chatMessages = useChatMessages();
  const [text, setText] = useState("");

  return (
    <>
      <h2>Chat messages</h2>
      {chatMessages.map((message) => (
        <Message key={message.messageId} message={message} />
      ))}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            upsertMessage(channelName, nanoid(), text);
            setText("");
          }
        }}
      />

      <button
        onClick={() => {
          upsertMessage(channelName, nanoid(), text);
          setText("");
        }}
      >
        Send
      </button>
    </>
  );
};

const View = () => {
  // const entities = useEntities()

  return (
    <div>
      <ChatView />

      {/* <h2>Entities</h2>
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
      ))} */}

      {/* <button
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
      </button> */}
    </div>
  );
};

export default function Page() {
  return (
    <>
      <PresenceView />
      <View />
    </>
  );
}
