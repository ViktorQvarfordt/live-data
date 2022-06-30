import { useState, useEffect, useRef, FC, useCallback } from "react";
import { customAlphabet } from "nanoid";
import _ from "lodash";
import { TypedEventEmitter } from "../lib";
import { Json, PresenceUpdates, PresenceUpsert } from "../types";
import { z } from "zod";

// https://en.bitcoinwiki.org/wiki/Base58
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const nanoid = customAlphabet(alphabet, 12);

type ClientId = string;
type PresenceMap = Map<ClientId, Json>;

class SseProvider extends TypedEventEmitter<{
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

class PresenceProvider extends TypedEventEmitter<{
  update: (presenceMap: PresenceMap) => void;
}> {
  private states: PresenceMap;
  private sseProvider: SseProvider | undefined = undefined;
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
    this.sseProvider?.destroy();
    super.off();
  }
}

type Op = {
  chatId: string;
  messageId: string;
} & ({ text: string } | { isDeleted: true });

const Message = z.object({
  messageId: z.string(),
  chatId: z.string(),
  chatSequenceId: z.number(),
  messageSequenceId: z.number(),
  createdAt: z.string(),
  isDeleted: z.boolean().optional(),
  text: z.string().optional(),
  isOptimistic: z.boolean().optional(),
});

const Messages = z.array(Message);

type Message = z.infer<typeof Message>;

// Exclude undefined from T
type NonUndefined<T> = T extends undefined ? never : T;

export function isDefined<T>(val: T): val is NonUndefined<T> {
  return val !== undefined;
}

const normalize = (rows: Message[]): Message[] => {
  console.log("normalize", { rows });

  const result = _.chain(rows)
    .groupBy((row) => row.messageId)
    .entries()
    .map(([, rows]) => _.maxBy(rows, (row) => row.isOptimistic ? -1 : row.messageSequenceId))
    .filter(isDefined)
    .filter((row) => !row.isDeleted)
    .orderBy((row) => row.chatSequenceId, "desc")
    .take(10)
    .reverse()
    .value();

  let seq = _.chain(result)
    .map((msg) => msg.chatSequenceId)
    .max()
    .value();

  // TODO: Deleted messaged are treated as holes
  let hasHole = false;
  for (let i = result.length - 1; i >= 0; i--) {
    if (!hasHole && result[i].chatSequenceId !== seq) {
      hasHole = true;
    } else {
      seq--;
    }

    if (hasHole) {
      result.splice(i, 1);
    }
  }

  console.log("normalize", { result });

  return Messages.parse(result);
};

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
  const [entities, setEntities] = useState<Message[]>([]);

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

const useChatMessages = (): [Message[], (op: Op) => void] => {
  const [chatMessages, setChatMessages] = useState<Message[]>([]);

  useEffect(() => {
    const baseUrl = "https://localhost:8000";

    const provider = new SseProvider(
      `${baseUrl}/chat/${channelName}/get`,
      `${baseUrl}/channel/${channelName}/sub`
    );

    provider.on("update", (str) => {
      const msgs = Messages.parse(JSON.parse(str));
      setChatMessages((messages) => normalize([...messages, ...msgs]));
    });

    provider.on("load", (msg) => setChatMessages(normalize(JSON.parse(msg))));

    provider.init();

    return () => provider.destroy();
  }, []);

  const upsertMessage = useCallback(
    async (
      op: {
        chatId: string;
        messageId: string;
      } & ({ text: string } | { isDeleted: true })
    ) => {
      setChatMessages((curr) => {
        const updated: Message[] = [];
        let wasFound = false;
        for (const msg of curr) {
          if (msg.messageId !== op.messageId) {
            updated.push(msg);
          } else {
            updated.push({
              ...msg,
              ...op,
              messageSequenceId: msg.messageSequenceId + 1,
              isOptimistic: true,
            });
            wasFound = true
          }
        }
        if (!wasFound) {
          const chatSequenceId =
            _.chain(updated)
              .map((msg) => msg.chatSequenceId)
              .max()
              .value() + 1;
          updated.push({
            ...op,
            messageSequenceId: 0,
            chatSequenceId,
            createdAt: new Date().toISOString(),
            isOptimistic: true,
          });
        }
        return normalize(updated);
      });
      await fetch(`${baseUrl}/chat/upsert`, {
        method: "post",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(op),
      });
    },
    []
  );

  return [chatMessages, upsertMessage];
};

const MessageComp: FC<{
  message: Message;
  upsertMessage: (op: Op) => void;
}> = ({ message, upsertMessage }) => {
  const [text, setText] = useState(message.text ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!("text" in message)) return;
    setText(message.text ?? "");
    inputRef.current?.blur();
  }, [message]);

  const send = () => {
    if ("text" in message && !_.isEqual(message.text, text)) {
      upsertMessage({
        chatId: message.chatId,
        messageId: message.messageId,
        text,
      });
    }
  };

  return (
    <div>
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={send}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            send();
            (e.target as HTMLInputElement)?.blur();
          } else if (e.key === "Escape") {
            (e.target as HTMLInputElement)?.blur();
          } else if (e.key === "Backspace" && text === "") {
            upsertMessage({
              chatId: message.chatId,
              messageId: message.messageId,
              isDeleted: true,
            });
          }
        }}
      />
      {message.messageSequenceId > 0 && "(edited)"}
    </div>
  );
};

const MessageComp2: FC<{
  message: Message;
  upsertMessage: (op: Op) => void;
}> = ({ message, upsertMessage }) => {
  return (
    <div>
      <input
        value={message.text}
        onChange={(e) =>
          upsertMessage({
            chatId: message.chatId,
            messageId: message.messageId,
            text: e.target.value,
          })
        }
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            (e.target as HTMLInputElement)?.blur();
          } else if (e.key === "Backspace" && message.text === "") {
            upsertMessage({
              chatId: message.chatId,
              messageId: message.messageId,
              isDeleted: true,
            });
          }
        }}
      />
      {message.messageSequenceId > 0 && "(edited)"}
    </div>
  );
};

const ChatView = () => {
  const [chatMessages, upsertMessage] = useChatMessages();
  const [text, setText] = useState("");

  return (
    <>
      <h2>Chat messages</h2>
      {chatMessages.length > 0 && chatMessages[0].chatSequenceId !== 0 && '...'}
      {chatMessages.map((message) => (
        <MessageComp2
          key={message.messageId}
          message={message}
          upsertMessage={upsertMessage}
        />
      ))}

      <textarea
        placeholder="Aa"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            upsertMessage({ chatId: channelName, messageId: nanoid(), text });
            setText("");
          }
        }}
      />

      <button
        onClick={() => {
          upsertMessage({ chatId: channelName, messageId: nanoid(), text });
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
