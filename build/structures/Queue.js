'use strict'

class Queue {
  constructor() {
    this._items = []
  }

  get size() {
    return this._items.length
  }

  get first() {
    return this._items[0] || null
  }

  get last() {
    return this._items[this._items.length - 1] || null
  }

  add(...tracks) {
    this._items.push(...tracks)
    return this
  }

  remove(track) {
    const idx = this._items.indexOf(track)
    if (idx === -1) return false
    const removed = this._items[idx]
    this._items.splice(idx, 1)
    if (removed?.dispose) removed.dispose()
    return true
  }

  clear() {
    for (let i = 0; i < this._items.length; i++) {
      if (this._items[i]?.dispose) this._items[i].dispose()
    }
    this._items.length = 0
  }

  shuffle() {
    for (let i = this._items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const temp = this._items[i]
      this._items[i] = this._items[j]
      this._items[j] = temp
    }
    return this
  }

  move(from, to) {
    if (from < 0 || from >= this._items.length || to < 0 || to >= this._items.length) return this
    const [item] = this._items.splice(from, 1)
    this._items.splice(to, 0, item)
    return this
  }

  swap(index1, index2) {
    if (index1 < 0 || index1 >= this._items.length || index2 < 0 || index2 >= this._items.length) return this
    const temp = this._items[index1]
    this._items[index1] = this._items[index2]
    this._items[index2] = temp
    return this
  }

  peek() {
    return this.first
  }

  toArray() {
    return [...this._items]
  }

  at(index) {
    return this._items[index] || null
  }

  dequeue() {
    return this._items.shift()
  }

  isEmpty() {
    return this._items.length === 0
  }

  enqueue(track) {
    return this.add(track)
  }
}

module.exports = Queue
