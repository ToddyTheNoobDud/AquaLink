const Connection = require('./structures/Connection')
const Filters = require('./structures/Filters')
const Node = require('./structures/Node')
const Aqua = require('./structures/Aqua')
const Player = require('./structures/Player')
const Plugin = require('./structures/Plugins')
const Queue = require('./structures/Queue')
const Rest = require('./structures/Rest')
const Track = require('./structures/Track')
const { AqualinkEvents } = require('./structures/AqualinkEvents')

const VoiceRegion = Object.freeze({
  // ─── Asia Pacific ─────────────────────────────────────────────────────────
  India: 'bom',
  Singapore: 'sin',
  Japan: 'nrt',
  SouthKorea: 'icn',
  HongKong: 'hkg',
  Australia: 'syd',
  Indonesia: 'cgk',

  // ─── Europe ───────────────────────────────────────────────────────────────
  Germany: 'fra',
  Netherlands: 'ams',
  UnitedKingdom: 'lhr',
  France: 'cdg',
  Spain: 'mad',
  Italy: 'mxp',
  Sweden: 'arn',
  Finland: 'hel',
  Poland: 'waw',
  Romania: 'buh',
  RussiaSTP: 'led',
  RussiaMoscow: 'svo',

  // ─── Middle East & Africa ─────────────────────────────────────────────────
  Israel: 'tlv',
  UAE: 'dxb',
  SaudiArabia: 'dmm',
  SouthAfrica: 'jnb',

  // ─── North America ────────────────────────────────────────────────────────
  USANewark: 'ewr',
  USAWashington: 'iad',
  USAAtlanta: 'atl',
  USAMiami: 'mia',
  USAChicago: 'ord',
  USADallas: 'dfw',
  USASeattle: 'sea',
  USALosAngeles: 'lax',
  CanadaToronto: 'yyz',
  CanadaMontreal: 'ymq',

  Brazil: 'gru' || 'brazil', // i only know this endpoint lol.
  Chile: 'scl' || 'chile',
  Argentina: 'eze' || 'argentina'
})

module.exports = {
  Connection,
  Filters,
  Node,
  Aqua,
  Player,
  Plugin,
  Queue,
  Rest,
  Track,
  VoiceRegion,
  AqualinkEvents
}
