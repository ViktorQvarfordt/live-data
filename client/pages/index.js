import { useState, useEffect } from "react";

// class SseDataProvider {
//   constructor({ sseUrl, onData, onOpen }) {
//     console.debug("Provider init");
 
//     this.eventSource = new EventSource(sseUrl);

//     this.eventSource.addEventListener("message", (event) => {
//       const data = JSON.parse(event.data);
//       console.debug("EventSource message", data);
//       onData?.(data);
//     });

//     this.eventSource.addEventListener("error", () => {
//       console.debug("EventSource error");
//     });

//     // Called when eventSource first opens and when recovering from error.
//     this.eventSource.addEventListener("open", () => {
//       console.debug("EventSource open");
//       onOpen?.();
//     });
//   }

//   destroy() {
//     console.debug("Provider destroy");
//     this.eventSource.close();
//   }
// }

const baseUrl = 'https://localhost:8000'

const Page = () => {
  // const [state, setState] = useState();
  // const [provider, setProvider] = useState();
  const [messages, setMessages] = useState([])

  useEffect(() => {
    const eventSource = new EventSource(`${baseUrl}/subscribe/chan1`)

    eventSource.addEventListener('message', event => {
      setMessages(messages => [event.data, ...messages])
    })

    return () => eventSource.close()
  }, [])

  // useEffect(() => {
  //   const baseUrl = "https://localhost:8000";

  //   const newProvider = new SseDataProvider({
  //     sseUrl: `${baseUrl}/subscribe/chan1`,
  //     onData: setState,
  //   });

  //   setProvider(newProvider);

  //   return () => {
  //     newProvider.destroy();
  //     setProvider(undefined);
  //   };
  // }, []);

  // if (!provider) return <>Loading...</>;

  return (
    <div>
      <pre>{JSON.stringify(messages, null, 2)}</pre>

      <button
        onClick={async () => {
          await fetch(`${baseUrl}/publish/chan1`, {
            method: "post",
            headers: {
              "content-type": "text/plain",
            },
            body: 'hello',
          });
        }}
      >
        pub
      </button>
    </div>
  );
};

export default Page;
