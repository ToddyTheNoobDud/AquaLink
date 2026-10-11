import EventEmitter from 'node:events'
import { WebSocket } from 'node:http'
import type AquaManager from '../aqua/Aqua'
import { RoutesForWebsocket } from '../shared/routes.ts'
import type { AquaOptions, NodeOptions } from '../types/shared.ts'

// https://bun.sh/reference/bun/Socket/readyState
// ig nodejs also follow that lol?
enum WEBSOCKET_STATES {
  Shutdown = -2,
  Detached = -1,
  Closed = 0,
  Established = 1,
  Else = 2
}

export default class Node extends EventEmitter {
  private aqua: AquaManager
  private name: string
  private host: string
  private ssl: boolean
  private port: number
  private password: string

  // node related stuff
  public connected: boolean

  constructor(
    aqua: AquaManager,
    nodeOptions: NodeOptions,
    options?: AquaOptions
  ) {
    super()
    this.aqua = aqua
    this.host = nodeOptions.host
    this.ssl = nodeOptions.ssl //?? this.secure = nodeOptions.secure
    this.port = nodeOptions.port
    this.password = nodeOptions.password
    this.name = nodeOptions.name

    this.connected = false
  }

  clientName() {
    return 'Aqualink/4.0.0 (https://github.com/ToddyTheNoobDud/AquaLink'
  }

  /**
   * connects to a given node
   *
   */
  public async connect() {
    if (this.connected) {
      return
    }

    const protocol = this.ssl ? 'wss' : 'ws'
    const websocketUrl = `${protocol}://${this.host}:${this.port}/${RoutesForWebsocket.WebsocketV4Route}`

    const websocket = new WebSocket(websocketUrl, {
      headers: {
        'Authorization': `${this.password}`,
        'User-Id': `${this.aqua.clientId}`,
        'Client-Name': this.clientName()
      }
    })

    websocket.addEventListener('message', (message) => {
      this.handleWebsocketMessages(message)
    })
    
    return websocket
  }

  private async handleWebsocketMessages(message: any) {
    const parsed = JSON.parse(message.data)

    switch (parsed.op) {
      case 'ready':
        console.log('Aqualink connected.')
        this.connected = true
      break
    }
    
    
  }

  private async handleWebsocketOpen(websocket: WebSocket) { 
    console.log(websocket)
    
  }
}
