import { useState, useEffect } from 'react'
import * as json from '@sanalabs/json'

class Provider {
  constructor({ sseUrl, getUrl, putUrl, onData }) {
    this.sseUrl = sseUrl
    this.getUrl = getUrl
    this.putUrl = putUrl
    this.onData = onData
    this.eventSource = new EventSource(sseUrl)

    this.eventSource.addEventListener('message', (event) => {
      const data = JSON.parse(event.data)
      console.log('got data', data)
      this.onData(data)
    })

    this.eventSource.addEventListener('error', () => {
      console.error('error')
    })

    this.eventSource.addEventListener('open', () => {
      this.get()
    })
  }

  async get() {
    const res = await fetch(this.getUrl)
    const data = await res.json()
    this.onData(data)
  }

  async put(delta) {
    console.log('put delta', delta)
    await fetch(this.putUrl, {
      method: 'post',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(delta)
    })
  }

  destroy() {
    this.eventSource.close()
  }
}

const Page = () => {
  const [state, setState] = useState()
  const [provider, setProvider] = useState()
  
  useEffect(() => {
    const baseUrl = 'https://localhost:8000'

    console.log('init provider')
    const newProvider = new Provider({
      sseUrl: `${baseUrl}/sse`,
      getUrl: `${baseUrl}/get`,
      putUrl: `${baseUrl}/put`,
      onData: setState
    })

    setProvider(newProvider)

    return () => {
    console.log('destroy provider')
    newProvider.destroy()
      setProvider(undefined)
    }
  }, [])
  
  if (!provider || !state) return <>Loading...</>

  return <div>
    Here is the data:
    <pre>{JSON.stringify(state, null, 2)}</pre>
    <button onClick={() => {
      const newState = { ...state, counter: Date.now() }
      const delta = json.diff(state, newState)
      return provider.put(delta)
    }}>put</button>
  </div>
}

export default Page
