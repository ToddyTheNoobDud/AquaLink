class Queue {
  constructor() {
    this._items = []
    this._head = 0
  }

  get size() {
    return this._items.length - this._head
  }

  get first() {
    return this._items[this._head] || null
  }

  get last() {
    return this._items[this._items.length - 1] || null
  }

  add(...tracks) {
    this._items.push(...tracks)
    return this
  }

  remove(track) {
    const idx = this._items.indexOf(track, this._head)
    if (idx === -1) return false
    const removed = this._items[idx]
    this._items.splice(idx, 1)
    if (removed?.dispose) removed.dispose()
    return true
  }

  clear() {
    for (let i = this._head; i < this._items.length; i++) {
      if (this._items[i]?.dispose) this._items[i].dispose()
    }
    this._items.length = 0
    this._head = 0
  }

  _compact(force = false) {
    if (this._head <= 0) return
    if (!force && this._head <= this._items.length / 2) return
    const len = this._items.length - this._head
    for (let i = 0; i < len; i++) {
      this._items[i] = this._items[this._head + i]
    }
    this._items.length = len
    this._head = 0
  }

  shuffle() {
    this._compact(true)
    for (let i = this._items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const temp = this._items[i]
      this._items[i] = this._items[j]
      this._items[j] = temp
    }
    return this
  }

  move(from, to) {
    const actualFrom = from + this._head
    const actualTo = to + this._head
    if (
      from < 0 ||
      actualFrom >= this._items.length ||
      to < 0 ||
      actualTo >= this._items.length
    )
      return this
    const [item] = this._items.splice(actualFrom, 1)
    this._items.splice(actualTo, 0, item)
    return this
  }

  swap(index1, index2) {
    const actual1 = index1 + this._head
    const actual2 = index2 + this._head
    if (
      index1 < 0 ||
      actual1 >= this._items.length ||
      index2 < 0 ||
      actual2 >= this._items.length
    )
      return this
    const temp = this._items[actual1]
    this._items[actual1] = this._items[actual2]
    this._items[actual2] = temp
    return this
  }

  peek() {
    return this.first
  }

  toArray() {
    return this._items.slice(this._head)
  }

  at(index) {
    return this._items[this._head + index] || null
  }

  dequeue() {
    if (this._head >= this._items.length) return undefined
    const item = this._items[this._head]
    this._items[this._head] = undefined // Allow GC
    this._head++
    this._compact(false)
    return item
  }

  isEmpty() {
    return this.size === 0
  }

  enqueue(track) {
    return this.add(track)
  }
}

module.exports = Queue
