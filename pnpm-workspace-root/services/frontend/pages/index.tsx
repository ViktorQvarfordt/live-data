import { useState, useEffect, useRef, FC, useCallback } from "react";
import _ from "lodash";
import { mkId } from "@workspace/common/id";
import { PresenceProvider, SseProvider } from "@workspace/live-provider"
import { Message, Messages, Op } from "@workspace/client/types.js";
import { asNonNullable, isNotUndefined } from "@workspace/common/assert";

const normalize = (rows: Message[]): Message[] => {
  console.log("normalize", { rows });

  const result = _.chain(rows)
    .groupBy((row) => row.messageId)
    .entries()
    .map(([, rows]) =>
      _.maxBy(rows, (row) => (row.isOptimistic ? -1 : row.messageSequenceId))
    )
    .filter(isNotUndefined)
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
    if (!hasHole && asNonNullable(result[i]).chatSequenceId !== seq) {
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
            wasFound = true;
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
      {chatMessages.length > 0 && asNonNullable(chatMessages[0]).chatSequenceId !== 0 && "..."}
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
            upsertMessage({ chatId: channelName, messageId: mkId(), text });
            setText("");
          }
        }}
      />

      <button
        onClick={() => {
          upsertMessage({ chatId: channelName, messageId: mkId(), text });
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
              entityId: mkId(),
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
