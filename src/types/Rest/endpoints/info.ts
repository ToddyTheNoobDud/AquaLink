export interface LavalinkInfo {
  version: {
    semver: string
    major: number
    minor: number
    patch: number
    preRelease: string | null
    build: string | null
  }
  buildTime: number
  git: {
    branch: string
    commit: string
    commitTime: number
  }
  jvm: string
  lavaplayer: string
  sourceManagers: string[]
  filters: string[]
  plugins: {
    name: string
    version: string
  }[]
}

export interface NodelinkInfo extends Omit<LavalinkInfo, 'jvm' | 'lavaplayer'> {
  node: string
  voice: {
    name: string
    version: string
  }
  isNodelink: boolean
}
