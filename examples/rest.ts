import { Rest } from '../src/index.ts'

export interface PluginStatus {
  enabled: boolean
}

export class BotRest extends Rest {
  getPluginStatus() {
    // Example route only. Change it to a route your server/plugin provides.
    // The type argument describes the response; it doesn't validate the JSON.
    return this.makeRequest<PluginStatus>('/v4/example-plugin/status')
  }
}
