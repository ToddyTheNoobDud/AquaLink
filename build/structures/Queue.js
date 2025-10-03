class Queue extends Array {
  get size() {
    return this.length
  }

  get first() {
    return this[0] || null
  }

  get last() {
    return this[this.length - 1] || null
  }


  add(track) {
    this.push(track)
    return this
  }

  remove(track) {
    const index = this.indexOf(track)
    if (index === -1) {
      return false
    }

    const removed = this[index]
    this.splice(index, 1)

    if (removed?.dispose) {
      removed.dispose()
    }

    return true
  }

  clear() {
    for (let i = 0; i < this.length; i++) {
      if (this[i]?.dispose) {
        this[i].dispose()
      }
    }
    this.length = 0
  }

  shuffle() {
    for (let i = this.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const temp = this[i]
      this[i] = this[j]
      this[j] = temp
    }
    return this
  }

  peek() {
    return this.first
  }

  toArray() {
    return this.slice()
  }

  at(index) {
    return this[index] || null
  }

  dequeue() {
    return this.shift()
  }

  isEmpty() {
    return this.length === 0
  }

  enqueue(track) {
    return this.add(track)
  }
}

module.exports = Queue
