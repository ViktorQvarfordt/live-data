import { useState, useEffect } from "react";
import _ from 'lodash'
import { customAlphabet } from 'nanoid'

const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 8)

class RowReplicator {
  eventSource: EventSource
  
  constructor(public sseUrl: string, public getUrl: string, public onData: (data: unknown[]) => void) {
    console.debug("Provider init");

    this.getUrl = getUrl;
    this.onData = onData;
    this.eventSource = new EventSource(sseUrl);

    this.eventSource.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      console.debug("EventSource message", data);
      this.onData?.(data);
    });

    this.eventSource.addEventListener("error", () => {
      console.debug("EventSource error");
    });

    // Called when eventSource first opens and when recovering from error.
    this.eventSource.addEventListener("open", () => {
      console.debug("EventSource open");
      this.get();
    });
  }

  async get() {
    const result = await fetch(this.getUrl);
    const data = await result.json();
    this.onData?.(data);
  }

  destroy() {
    console.debug("Provider destroy");
    this.eventSource.close();
  }
}

const deduplicate = (rows: { serialId, entityId }[]) => _.chain(rows).groupBy(row => row.entityId).entries().map(([, rows]) => _.maxBy(rows, row => row.serialId)).value()

const baseUrl = "https://localhost:8000";

const Page = () => {
  const [provider, setProvider] = useState<RowReplicator>();
  const [entities, setEntities] = useState([]);

  useEffect(() => {
    const baseUrl = "https://localhost:8000";

    const newProvider = new RowReplicator(
      `${baseUrl}/subscribe/chan1`,
      `${baseUrl}/load/chan1`,
      (rows) => setEntities((messages) => deduplicate([...messages, ...rows])),
    );

    setProvider(newProvider);

    return () => {
      newProvider.destroy();
      setProvider(undefined);
    };
  }, []);

  if (!provider) return <>Loading...</>;

  return (
    <div>
      {entities.map(entity => (
        <div key={entity.entityId}>{entity.data.text} <button onClick={async () => {
          await fetch(`${baseUrl}/publish/chan1`, {
            method: "post",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              entityType: "chatMessage",
              entityId: entity.entityId,
              data: { text: `Hello, world! ${Math.random()}` },
            }),
          });
        }}>Update</button></div>
      ))}

      <button
        onClick={async () => {
          await fetch(`${baseUrl}/publish/chan1`, {
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

export default Page;
