export type VimMode = "normal" | "insert"

export interface VimKeyEvent {
  key: string
  ctrl: boolean
  shift: boolean
  meta: boolean
}

export interface VimResult {
  consumed: boolean
  newText?: string
  newCursor?: number
  modeChange?: VimMode
}

type FtType = "f" | "F" | "t" | "T"

type ChangeRecord =
  | { kind: "x" }
  | { kind: "delete"; motion: string; motionArg?: string }
  | { kind: "change"; motion: string; motionArg?: string; insertedText: string }
  | { kind: "change-line"; insertedText: string }
  | { kind: "change-eol"; insertedText: string }
  | { kind: "paste"; before: boolean }
  | { kind: "open"; before: boolean; insertedText: string }
  | { kind: "join" }
  | { kind: "indent"; left: boolean }

type InsertSession = {
  baseText: string
  baseCursor: number
  seed:
    | { kind: "change"; motion: string; motionArg?: string }
    | { kind: "change-line" }
    | { kind: "change-eol" }
    | { kind: "open"; before: boolean }
    | null
}

export class VimEngine {
  private mode: VimMode = "normal"
  private pending = ""
  private register = ""
  private lastChange: ChangeRecord | null = null
  private lastFtMotion: { type: FtType; char: string } | null = null
  private insertSession: InsertSession | null = null

  getMode(): VimMode {
    return this.mode
  }

  reset(): void {
    this.mode = "normal"
    this.pending = ""
    this.insertSession = null
  }

  handleKey(event: VimKeyEvent, text: string, cursor: number): VimResult {
    const key = event.shift && event.key.length === 1 ? event.key.toUpperCase() : event.key

    if (this.mode === "insert") {
      if (key === "Escape" || key === "escape") {
        this.mode = "normal"
        this.pending = ""
        if (this.insertSession?.seed) {
          const insertedText = this.extractInsertedText(this.insertSession.baseText, text)
          const seed = this.insertSession.seed
          if (seed.kind === "change") {
            this.lastChange = {
              kind: "change",
              motion: seed.motion,
              motionArg: seed.motionArg,
              insertedText,
            }
          } else if (seed.kind === "change-line") {
            this.lastChange = { kind: "change-line", insertedText }
          } else if (seed.kind === "change-eol") {
            this.lastChange = { kind: "change-eol", insertedText }
          } else {
            this.lastChange = { kind: "open", before: seed.before, insertedText }
          }
        }
        this.insertSession = null
        return { consumed: true, newCursor: text.length > 0 ? Math.max(0, cursor - 1) : 0, modeChange: "normal" }
      }
      return { consumed: false }
    }

    // Normal mode: cursor sits ON a character, never past the last one
    const safeCursor = text.length > 0 ? this.clamp(cursor, 0, text.length - 1) : 0

    if (key === "Escape" || key === "escape") {
      this.pending = ""
      return { consumed: true }
    }

    if (this.pending !== "") {
      return this.handlePendingKey(key, text, safeCursor)
    }

    if (key === "i") {
      return this.enterInsert(text, safeCursor, null)
    }
    if (key === "I") {
      const { start, end } = this.getLineRange(text, safeCursor)
      let target = start
      while (target < end && this.isBlank(text[target])) target++
      return this.enterInsert(text, target, null)
    }
    if (key === "a") {
      const { end } = this.getLineRange(text, safeCursor)
      return this.enterInsert(text, this.clamp(safeCursor + 1, 0, end), null)
    }
    if (key === "A") {
      const { end } = this.getLineRange(text, safeCursor)
      return this.enterInsert(text, end, null)
    }
    if (key === "o") {
      return this.openLine(text, safeCursor, false, false)
    }
    if (key === "O") {
      return this.openLine(text, safeCursor, true, false)
    }

    if (key === "h") return { consumed: true, newCursor: this.moveLeft(text, safeCursor) }
    if (key === "l") return { consumed: true, newCursor: this.moveRight(text, safeCursor) }
    if (key === "j") return { consumed: true, newCursor: this.moveVertical(text, safeCursor, 1) }
    if (key === "k") return { consumed: true, newCursor: this.moveVertical(text, safeCursor, -1) }
    if (key === "w") return { consumed: true, newCursor: this.findNextWordStart(text, safeCursor) }
    if (key === "e") return { consumed: true, newCursor: this.findNextWordEnd(text, safeCursor) }
    if (key === "b") return { consumed: true, newCursor: this.findPrevWordStart(text, safeCursor) }
    if (key === "0") return { consumed: true, newCursor: this.getLineRange(text, safeCursor).start }
    if (key === "$") return { consumed: true, newCursor: this.getLineRange(text, safeCursor).end }
    if (key === "^") {
      const { start, end } = this.getLineRange(text, safeCursor)
      let i = start
      while (i < end && this.isBlank(text[i])) i++
      return { consumed: true, newCursor: i }
    }
    if (key === "G") return { consumed: true, newCursor: text.length }

    if (key === "f" || key === "F" || key === "t" || key === "T" || key === "g") {
      this.pending = key
      return { consumed: true }
    }

    if (key === ";") {
      if (!this.lastFtMotion) return { consumed: true }
      const target = this.resolveFtMotion(text, safeCursor, this.lastFtMotion.type, this.lastFtMotion.char)
      return { consumed: true, newCursor: target ?? safeCursor }
    }
    if (key === ",") {
      if (!this.lastFtMotion) return { consumed: true }
      const reversed = this.reverseFtType(this.lastFtMotion.type)
      const target = this.resolveFtMotion(text, safeCursor, reversed, this.lastFtMotion.char)
      return { consumed: true, newCursor: target ?? safeCursor }
    }

    if (key === "x") {
      if (safeCursor >= text.length) return { consumed: true }
      const { end } = this.getLineRange(text, safeCursor)
      if (safeCursor >= end) return { consumed: true }
      const deleted = text[safeCursor]
      const out = this.deleteRange(text, safeCursor, safeCursor + 1)
      this.register = deleted
      this.lastChange = { kind: "x" }
      return { consumed: true, newText: out.text, newCursor: out.cursor }
    }

    if (key === "D") {
      const range = this.getMotionRange(text, safeCursor, "$")
      if (!range || range.start === range.end) return { consumed: true }
      const out = this.deleteRange(text, range.start, range.end)
      this.register = text.slice(range.start, range.end)
      this.lastChange = { kind: "delete", motion: "$" }
      return { consumed: true, newText: out.text, newCursor: out.cursor }
    }

    if (key === "C") {
      const range = this.getMotionRange(text, safeCursor, "$")
      if (!range || range.start === range.end) return this.enterInsert(text, safeCursor, { kind: "change-eol" })
      const out = this.deleteRange(text, range.start, range.end)
      this.register = text.slice(range.start, range.end)
      this.insertSession = { baseText: out.text, baseCursor: out.cursor, seed: { kind: "change-eol" } }
      this.mode = "insert"
      this.pending = ""
      return { consumed: true, newText: out.text, newCursor: out.cursor, modeChange: "insert" }
    }

    if (key === "J") {
      const out = this.joinLine(text, safeCursor)
      if (!out) return { consumed: true }
      this.lastChange = { kind: "join" }
      return { consumed: true, newText: out.text, newCursor: out.cursor }
    }

    if (key === "p") return this.paste(text, safeCursor, false, false)
    if (key === "P") return this.paste(text, safeCursor, true, false)

    if (key === "Y") {
      this.yankCurrentLine(text, safeCursor)
      return { consumed: true }
    }

    if (key === ".") {
      const repeated = this.repeatLastChange(text, safeCursor)
      return repeated ?? { consumed: true }
    }

    if (key === "d" || key === "c" || key === "y" || key === ">" || key === "<") {
      this.pending = key
      return { consumed: true }
    }

    return { consumed: false }
  }

  private handlePendingKey(key: string, text: string, cursor: number): VimResult {
    const pending = this.pending

    if (pending === "g") {
      this.pending = ""
      if (key === "g") return { consumed: true, newCursor: 0 }
      return { consumed: true }
    }

    if (pending === "f" || pending === "F" || pending === "t" || pending === "T") {
      this.pending = ""
      if (key.length !== 1) return { consumed: true }
      const target = this.resolveFtMotion(text, cursor, pending, key)
      if (target == null) return { consumed: true }
      this.lastFtMotion = { type: pending, char: key }
      return { consumed: true, newCursor: target }
    }

    if (pending === ">" || pending === "<") {
      this.pending = ""
      if (key !== pending) return { consumed: true }
      const out = pending === ">" ? this.indentLine(text, cursor, false) : this.indentLine(text, cursor, true)
      if (!out) return { consumed: true }
      this.lastChange = { kind: "indent", left: pending === "<" }
      return { consumed: true, newText: out.text, newCursor: out.cursor }
    }

    const op = pending[0]
    if (op !== "d" && op !== "c" && op !== "y") {
      this.pending = ""
      return { consumed: true }
    }

    if (pending.length === 1 && key === op) {
      this.pending = ""
      if (op === "y") {
        this.yankCurrentLine(text, cursor)
        return { consumed: true }
      }
      if (op === "d") {
        const out = this.deleteCurrentLine(text, cursor)
        if (!out) return { consumed: true }
        this.register = out.deleted
        this.lastChange = { kind: "delete", motion: "line" }
        return { consumed: true, newText: out.text, newCursor: out.cursor }
      }
      const out = this.changeCurrentLine(text, cursor)
      if (!out) {
        return this.enterInsert(text, this.getLineRange(text, cursor).start, { kind: "change-line" })
      }
      this.register = out.deleted
      this.mode = "insert"
      this.insertSession = { baseText: out.text, baseCursor: out.cursor, seed: { kind: "change-line" } }
      return { consumed: true, newText: out.text, newCursor: out.cursor, modeChange: "insert" }
    }

    if (pending.length === 1 && (key === "f" || key === "F" || key === "t" || key === "T")) {
      this.pending = pending + key
      return { consumed: true }
    }

    if (
      pending.length === 2 &&
      (pending[1] === "f" || pending[1] === "F" || pending[1] === "t" || pending[1] === "T")
    ) {
      this.pending = ""
      if (key.length !== 1) return { consumed: true }
      return this.applyOperator(op, text, cursor, pending[1], key)
    }

    if (pending.length === 1 && (key === "i" || key === "a")) {
      this.pending = pending + key
      return { consumed: true }
    }

    if (pending.length === 2 && (pending[1] === "i" || pending[1] === "a")) {
      this.pending = ""
      return this.applyTextObjectOperator(op, text, cursor, pending[1] === "a", key)
    }

    this.pending = ""
    return this.applyOperator(op, text, cursor, key)
  }

  private applyOperator(
    op: "d" | "c" | "y",
    text: string,
    cursor: number,
    motion: string,
    motionArg?: string,
  ): VimResult {
    // cw special case: when cursor is on a non-blank character, cw acts like ce
    // This matches Neovim behavior (normal.c#L5951-5968)
    let effectiveMotion = motion
    if (op === "c" && motion === "w" && cursor < text.length && !this.isWhitespace(text[cursor])) {
      effectiveMotion = "e"
    }
    const range = this.getMotionRange(text, cursor, effectiveMotion, motionArg)
    if (!range || range.start === range.end) {
      if (op === "c") return this.enterInsert(text, cursor, { kind: "change", motion, motionArg })
      return { consumed: true }
    }

    const chunk = text.slice(range.start, range.end)

    if (op === "y") {
      this.register = chunk
      return { consumed: true }
    }

    const out = this.deleteRange(text, range.start, range.end)
    this.register = chunk

    if (op === "d") {
      this.lastChange = { kind: "delete", motion, motionArg }
      return { consumed: true, newText: out.text, newCursor: out.cursor }
    }

    this.mode = "insert"
    this.insertSession = { baseText: out.text, baseCursor: out.cursor, seed: { kind: "change", motion, motionArg } }
    return { consumed: true, newText: out.text, newCursor: out.cursor, modeChange: "insert" }
  }

  private applyTextObjectOperator(
    op: "d" | "c" | "y",
    text: string,
    cursor: number,
    around: boolean,
    obj: string,
  ): VimResult {
    let range: { start: number; end: number } | null = null
    if (obj === "w") range = this.findWordRange(text, cursor, around)
    if (obj === "W") range = this.findWORDRange(text, cursor, around)
    if (obj === '"') range = this.findDelimitedRange(text, cursor, '"', '"', around)
    if (obj === "'") range = this.findDelimitedRange(text, cursor, "'", "'", around)
    if (obj === "(") range = this.findDelimitedRange(text, cursor, "(", ")", around)
    if (obj === "[") range = this.findDelimitedRange(text, cursor, "[", "]", around)
    if (obj === "{") range = this.findDelimitedRange(text, cursor, "{", "}", around)
    if (!range || range.start === range.end) return { consumed: true }

    const motion = `${around ? "a" : "i"}${obj}`
    const chunk = text.slice(range.start, range.end)

    if (op === "y") {
      this.register = chunk
      return { consumed: true }
    }

    const out = this.deleteRange(text, range.start, range.end)
    this.register = chunk

    if (op === "d") {
      this.lastChange = { kind: "delete", motion }
      return { consumed: true, newText: out.text, newCursor: out.cursor }
    }

    this.mode = "insert"
    this.insertSession = { baseText: out.text, baseCursor: out.cursor, seed: { kind: "change", motion } }
    return { consumed: true, newText: out.text, newCursor: out.cursor, modeChange: "insert" }
  }

  private repeatLastChange(text: string, cursor: number): VimResult | null {
    if (!this.lastChange) return { consumed: true }
    const c = this.lastChange

    if (c.kind === "x") {
      if (cursor >= text.length) return { consumed: true }
      const { end } = this.getLineRange(text, cursor)
      if (cursor >= end) return { consumed: true }
      const out = this.deleteRange(text, cursor, cursor + 1)
      this.register = text.slice(cursor, cursor + 1)
      return { consumed: true, newText: out.text, newCursor: out.cursor }
    }

    if (c.kind === "delete") {
      if (c.motion === "line") {
        const out = this.deleteCurrentLine(text, cursor)
        if (!out) return { consumed: true }
        this.register = out.deleted
        return { consumed: true, newText: out.text, newCursor: out.cursor }
      }
      return this.applyOperator("d", text, cursor, c.motion, c.motionArg)
    }

    if (c.kind === "change") {
      const range = this.getMotionRange(text, cursor, c.motion, c.motionArg)
      if (!range) return { consumed: true }
      const out = this.deleteRange(text, range.start, range.end)
      const next = this.insertAt(out.text, out.cursor, c.insertedText)
      return { consumed: true, newText: next.text, newCursor: next.cursor }
    }

    if (c.kind === "change-line") {
      const out = this.changeCurrentLine(text, cursor)
      if (!out) {
        const next = this.insertAt(text, this.getLineRange(text, cursor).start, c.insertedText)
        return { consumed: true, newText: next.text, newCursor: next.cursor }
      }
      const next = this.insertAt(out.text, out.cursor, c.insertedText)
      return { consumed: true, newText: next.text, newCursor: next.cursor }
    }

    if (c.kind === "change-eol") {
      const range = this.getMotionRange(text, cursor, "$")
      if (!range) return { consumed: true }
      const out = this.deleteRange(text, range.start, range.end)
      const next = this.insertAt(out.text, out.cursor, c.insertedText)
      return { consumed: true, newText: next.text, newCursor: next.cursor }
    }

    if (c.kind === "paste") {
      return this.paste(text, cursor, c.before, true)
    }

    if (c.kind === "open") {
      return this.openLine(text, cursor, c.before, true, c.insertedText)
    }

    if (c.kind === "join") {
      const out = this.joinLine(text, cursor)
      if (!out) return { consumed: true }
      return { consumed: true, newText: out.text, newCursor: out.cursor }
    }

    const out = this.indentLine(text, cursor, c.left)
    if (!out) return { consumed: true }
    return { consumed: true, newText: out.text, newCursor: out.cursor }
  }

  private openLine(text: string, cursor: number, before: boolean, repeating: boolean, insertedText = ""): VimResult {
    const { start, end } = this.getLineRange(text, cursor)
    const insertAt = before ? start : end < text.length ? end + 1 : text.length
    let created = text.slice(0, insertAt) + "\n" + text.slice(insertAt)
    let newCursor = before ? insertAt : insertAt + 1

    if (repeating) {
      const withText = this.insertAt(created, newCursor, insertedText)
      return { consumed: true, newText: withText.text, newCursor: withText.cursor }
    }

    this.mode = "insert"
    this.insertSession = {
      baseText: created,
      baseCursor: newCursor,
      seed: { kind: "open", before },
    }
    this.pending = ""
    this.lastChange = { kind: "open", before, insertedText: "" }
    return { consumed: true, newText: created, newCursor, modeChange: "insert" }
  }

  private paste(text: string, cursor: number, before: boolean, repeating: boolean): VimResult {
    if (!this.register) return { consumed: true }
    const linewise = this.register.endsWith("\n")
    let insertAt = cursor

    if (linewise) {
      const { start, end } = this.getLineRange(text, cursor)
      if (before) {
        insertAt = start
      } else {
        insertAt = end < text.length ? end + 1 : text.length
      }
    } else {
      if (before) {
        insertAt = cursor
      } else {
        const { end } = this.getLineRange(text, cursor)
        insertAt = this.clamp(cursor + 1, 0, end)
      }
    }

    const out = this.insertAt(text, insertAt, this.register)
    if (!repeating) this.lastChange = { kind: "paste", before }
    return { consumed: true, newText: out.text, newCursor: out.cursor }
  }

  private enterInsert(text: string, cursor: number, seed: InsertSession["seed"]): VimResult {
    this.mode = "insert"
    this.pending = ""
    this.insertSession = { baseText: text, baseCursor: cursor, seed }
    return { consumed: true, newCursor: cursor, modeChange: "insert" }
  }

  private moveLeft(text: string, cursor: number): number {
    const { start } = this.getLineRange(text, cursor)
    return Math.max(start, cursor - 1)
  }

  private moveRight(text: string, cursor: number): number {
    const { end } = this.getLineRange(text, cursor)
    return Math.min(end, cursor + 1)
  }

  private moveVertical(text: string, cursor: number, delta: -1 | 1): number {
    const cur = this.getLineRange(text, cursor)
    if (delta < 0) {
      if (cur.start === 0) return cursor
      const prevEnd = cur.start - 1
      const prev = this.getLineRange(text, prevEnd)
      const col = cursor - cur.start
      return this.clamp(prev.start + col, prev.start, prev.end)
    }
    if (cur.end >= text.length) return cursor
    const nextStart = cur.end + 1
    const next = this.getLineRange(text, nextStart)
    const col = cursor - cur.start
    return this.clamp(next.start + col, next.start, next.end)
  }

  private deleteCurrentLine(text: string, cursor: number): { text: string; cursor: number; deleted: string } | null {
    if (text.length === 0) return null
    const { start, end } = this.getLineRange(text, cursor)

    let delStart = start
    let delEnd = end
    if (end < text.length) {
      delEnd = end + 1
    } else if (start > 0) {
      delStart = start - 1
    }

    const deleted = text.slice(delStart, delEnd)
    const out = this.deleteRange(text, delStart, delEnd)
    return { text: out.text, cursor: out.cursor, deleted }
  }

  private changeCurrentLine(text: string, cursor: number): { text: string; cursor: number; deleted: string } | null {
    if (text.length === 0) return null
    const { start, end } = this.getLineRange(text, cursor)
    if (start === end) return { text, cursor: start, deleted: "" }
    const deleted = text.slice(start, end)
    const out = this.deleteRange(text, start, end)
    return { text: out.text, cursor: out.cursor, deleted }
  }

  private yankCurrentLine(text: string, cursor: number): void {
    const { start, end } = this.getLineRange(text, cursor)
    const line = this.getCurrentLine(text, cursor)
    this.register = end < text.length ? line + "\n" : line + "\n"
  }

  private joinLine(text: string, cursor: number): { text: string; cursor: number } | null {
    const { end } = this.getLineRange(text, cursor)
    if (end >= text.length) return null
    let next = end + 1
    while (next < text.length && (text[next] === " " || text[next] === "\t")) next++
    const out = text.slice(0, end) + " " + text.slice(next)
    return { text: out, cursor: end }
  }

  private indentLine(text: string, cursor: number, left: boolean): { text: string; cursor: number } | null {
    const { start } = this.getLineRange(text, cursor)
    if (!left) {
      const out = text.slice(0, start) + "  " + text.slice(start)
      return { text: out, cursor: cursor + 2 }
    }

    let remove = 0
    while (remove < 2 && start + remove < text.length && text[start + remove] === " ") remove++
    if (remove === 0) return { text, cursor }
    const out = text.slice(0, start) + text.slice(start + remove)
    const nextCursor = cursor < start + remove ? start : cursor - remove
    return { text: out, cursor: nextCursor }
  }

  private insertAt(text: string, offset: number, chunk: string): { text: string; cursor: number } {
    const at = this.clamp(offset, 0, text.length)
    const out = text.slice(0, at) + chunk + text.slice(at)
    return { text: out, cursor: at + chunk.length }
  }

  private extractInsertedText(before: string, after: string): string {
    let start = 0
    const minLen = Math.min(before.length, after.length)
    while (start < minLen && before[start] === after[start]) start++

    let endBefore = before.length - 1
    let endAfter = after.length - 1
    while (endBefore >= start && endAfter >= start && before[endBefore] === after[endAfter]) {
      endBefore--
      endAfter--
    }
    return after.slice(start, endAfter + 1)
  }

  private getLineRange(text: string, cursor: number): { start: number; end: number } {
    const c = this.clamp(cursor, 0, text.length)
    const start = c === 0 ? 0 : Math.max(0, text.lastIndexOf("\n", c - 1) + 1)
    const nl = text.indexOf("\n", c)
    const end = nl === -1 ? text.length : nl
    return { start, end }
  }

  private getCurrentLine(text: string, cursor: number): string {
    const { start, end } = this.getLineRange(text, cursor)
    return text.slice(start, end)
  }

  private findNextWordStart(text: string, cursor: number): number {
    if (text.length === 0) return 0
    if (cursor >= text.length) return text.length

    let i = cursor
    if (!this.isWhitespace(text[i])) {
      if (this.isWordChar(text[i])) while (i < text.length && this.isWordChar(text[i])) i++
      else while (i < text.length && !this.isWhitespace(text[i]) && !this.isWordChar(text[i])) i++
    }
    while (i < text.length && this.isWhitespace(text[i])) i++
    return i
  }

  private findNextWordEnd(text: string, cursor: number): number {
    if (text.length === 0) return 0
    if (cursor >= text.length) return text.length

    // Neovim's end_word() always advances at least 1 character first
    let i = cursor + 1
    if (i >= text.length) return text.length - 1

    // Skip whitespace after advancing
    while (i < text.length && this.isWhitespace(text[i])) i++
    if (i >= text.length) return text.length - 1

    // Skip to end of current word class
    if (this.isWordChar(text[i])) while (i < text.length && this.isWordChar(text[i])) i++
    else while (i < text.length && !this.isWhitespace(text[i]) && !this.isWordChar(text[i])) i++
    return Math.max(0, i - 1)
  }

  private findPrevWordStart(text: string, cursor: number): number {
    if (text.length === 0) return 0
    if (cursor <= 0) return 0

    let i = cursor - 1
    while (i >= 0 && this.isWhitespace(text[i])) i--
    if (i < 0) return 0

    if (this.isWordChar(text[i])) while (i >= 0 && this.isWordChar(text[i])) i--
    else while (i >= 0 && !this.isWhitespace(text[i]) && !this.isWordChar(text[i])) i--
    return i + 1
  }

  private findNextWORDStart(text: string, cursor: number): number {
    if (text.length === 0) return 0
    if (cursor >= text.length) return text.length
    let i = cursor
    if (!this.isWhitespace(text[i])) while (i < text.length && !this.isWhitespace(text[i])) i++
    while (i < text.length && this.isWhitespace(text[i])) i++
    return i
  }

  private findPrevWORDStart(text: string, cursor: number): number {
    if (text.length === 0) return 0
    if (cursor <= 0) return 0
    let i = cursor - 1
    while (i >= 0 && this.isWhitespace(text[i])) i--
    while (i >= 0 && !this.isWhitespace(text[i])) i--
    return i + 1
  }

  private findWordRange(text: string, cursor: number, around: boolean): { start: number; end: number } | null {
    if (text.length === 0) return null
    let i = this.clamp(cursor, 0, text.length - 1)

    if (this.isWhitespace(text[i])) {
      // iw on whitespace: select the whitespace run itself (Neovim behavior)
      let wsStart = i
      let wsEnd = i + 1
      while (wsStart > 0 && this.isWhitespace(text[wsStart - 1])) wsStart--
      while (wsEnd < text.length && this.isWhitespace(text[wsEnd])) wsEnd++
      if (!around) return { start: wsStart, end: wsEnd }
      // aw on whitespace: whitespace + next word (or prev word if at end)
      if (wsEnd < text.length) {
        let wordEnd = wsEnd
        if (this.isWordChar(text[wordEnd])) while (wordEnd < text.length && this.isWordChar(text[wordEnd])) wordEnd++
        else
          while (wordEnd < text.length && !this.isWhitespace(text[wordEnd]) && !this.isWordChar(text[wordEnd]))
            wordEnd++
        return { start: wsStart, end: wordEnd }
      }
      if (wsStart > 0) {
        let wordStart = wsStart - 1
        if (this.isWordChar(text[wordStart])) while (wordStart > 0 && this.isWordChar(text[wordStart - 1])) wordStart--
        else
          while (wordStart > 0 && !this.isWhitespace(text[wordStart - 1]) && !this.isWordChar(text[wordStart - 1]))
            wordStart--
        return { start: wordStart, end: wsEnd }
      }
      return { start: wsStart, end: wsEnd }
    }

    const kind = this.isWordChar(text[i]) ? "word" : "punct"
    let start = i
    let end = i + 1
    while (start > 0) {
      const ch = text[start - 1]
      if (this.isWhitespace(ch)) break
      if (kind === "word" && !this.isWordChar(ch)) break
      if (kind === "punct" && this.isWordChar(ch)) break
      start--
    }
    while (end < text.length) {
      const ch = text[end]
      if (this.isWhitespace(ch)) break
      if (kind === "word" && !this.isWordChar(ch)) break
      if (kind === "punct" && this.isWordChar(ch)) break
      end++
    }

    if (!around) return { start, end }

    let outEnd = end
    while (outEnd < text.length && this.isWhitespace(text[outEnd])) outEnd++
    if (outEnd > end) return { start, end: outEnd }

    let outStart = start
    while (outStart > 0 && this.isWhitespace(text[outStart - 1])) outStart--
    return { start: outStart, end }
  }

  private findWORDRange(text: string, cursor: number, around: boolean): { start: number; end: number } | null {
    if (text.length === 0) return null
    let i = this.clamp(cursor, 0, text.length - 1)
    if (this.isWhitespace(text[i])) {
      // iW on whitespace: select the whitespace run itself
      let wsStart = i
      let wsEnd = i + 1
      while (wsStart > 0 && this.isWhitespace(text[wsStart - 1])) wsStart--
      while (wsEnd < text.length && this.isWhitespace(text[wsEnd])) wsEnd++
      if (!around) return { start: wsStart, end: wsEnd }
      // aW on whitespace: whitespace + next WORD (or prev if at end)
      if (wsEnd < text.length) {
        let wordEnd = wsEnd
        while (wordEnd < text.length && !this.isWhitespace(text[wordEnd])) wordEnd++
        return { start: wsStart, end: wordEnd }
      }
      if (wsStart > 0) {
        let wordStart = wsStart - 1
        while (wordStart > 0 && !this.isWhitespace(text[wordStart - 1])) wordStart--
        return { start: wordStart, end: wsEnd }
      }
      return { start: wsStart, end: wsEnd }
    }

    let start = i
    let end = i + 1
    while (start > 0 && !this.isWhitespace(text[start - 1])) start--
    while (end < text.length && !this.isWhitespace(text[end])) end++
    if (!around) return { start, end }

    let outEnd = end
    while (outEnd < text.length && this.isWhitespace(text[outEnd])) outEnd++
    if (outEnd > end) return { start, end: outEnd }

    let outStart = start
    while (outStart > 0 && this.isWhitespace(text[outStart - 1])) outStart--
    return { start: outStart, end }
  }

  private findDelimitedRange(
    text: string,
    cursor: number,
    open: string,
    close: string,
    around: boolean,
  ): { start: number; end: number } | null {
    if (text.length === 0) return null

    if (open === close) {
      const line = this.getLineRange(text, cursor)
      const c = this.clamp(cursor, line.start, line.end)
      for (let left = c; left >= line.start; left--) {
        if (text[left] !== open) continue
        for (let right = left + 1; right < line.end; right++) {
          if (text[right] !== close) continue
          if (c >= left && c <= right) {
            return around ? { start: left, end: right + 1 } : { start: left + 1, end: right }
          }
        }
      }
      return null
    }

    const c = this.clamp(cursor, 0, text.length)
    let depth = 0
    let left: number | null = null
    for (let i = c; i >= 0; i--) {
      const ch = text[i]
      if (ch === close) depth++
      if (ch === open) {
        if (depth === 0) {
          left = i
          break
        }
        depth--
      }
    }
    if (left == null) return null

    depth = 0
    let right: number | null = null
    for (let i = left + 1; i < text.length; i++) {
      const ch = text[i]
      if (ch === open) depth++
      if (ch === close) {
        if (depth === 0) {
          right = i
          break
        }
        depth--
      }
    }
    if (right == null) return null
    if (c < left || c > right) return null

    return around ? { start: left, end: right + 1 } : { start: left + 1, end: right }
  }

  private findCharForward(text: string, cursor: number, char: string): number | null {
    const { end } = this.getLineRange(text, cursor)
    for (let i = cursor + 1; i < end; i++) {
      if (text[i] === char) return i
    }
    return null
  }

  private findCharBackward(text: string, cursor: number, char: string): number | null {
    const { start } = this.getLineRange(text, cursor)
    for (let i = cursor - 1; i >= start; i--) {
      if (text[i] === char) return i
    }
    return null
  }

  private deleteRange(text: string, start: number, end: number): { text: string; cursor: number } {
    const s = this.clamp(Math.min(start, end), 0, text.length)
    const e = this.clamp(Math.max(start, end), 0, text.length)
    return {
      text: text.slice(0, s) + text.slice(e),
      cursor: s,
    }
  }

  private getMotionRange(
    text: string,
    cursor: number,
    motion: string,
    motionArg?: string,
  ): { start: number; end: number } | null {
    const c = this.clamp(cursor, 0, text.length)
    if (motion === "line") {
      const { start, end } = this.getLineRange(text, c)
      if (end < text.length) return { start, end: end + 1 }
      if (start > 0) return { start: start - 1, end }
      return { start, end }
    }

    if (motion === "w") return this.toRange(c, this.findNextWordStart(text, c), false)
    if (motion === "e") return this.toRange(c, this.findNextWordEnd(text, c), true)
    if (motion === "b") return this.toRange(c, this.findPrevWordStart(text, c), false)
    if (motion === "0") return this.toRange(c, this.getLineRange(text, c).start, false)
    if (motion === "$") return this.toRange(c, this.getLineRange(text, c).end, false)
    if (motion === "^") {
      const { start, end } = this.getLineRange(text, c)
      let i = start
      while (i < end && this.isBlank(text[i])) i++
      return this.toRange(c, i, false)
    }

    if (motion === "f" || motion === "F" || motion === "t" || motion === "T") {
      if (!motionArg || motionArg.length !== 1) return null
      const target = this.resolveFtMotion(text, c, motion, motionArg)
      if (target == null) return null
      this.lastFtMotion = { type: motion, char: motionArg }
      const inclusive = motion === "f" || motion === "F"
      return this.toRange(c, target, inclusive)
    }

    if (motion === "iw" || motion === "aw" || motion === "iW" || motion === "aW") {
      return motion === "iw"
        ? this.findWordRange(text, c, false)
        : motion === "aw"
          ? this.findWordRange(text, c, true)
          : motion === "iW"
            ? this.findWORDRange(text, c, false)
            : this.findWORDRange(text, c, true)
    }

    if (motion.length === 2 && (motion[0] === "i" || motion[0] === "a")) {
      const around = motion[0] === "a"
      const obj = motion[1]
      if (obj === '"') return this.findDelimitedRange(text, c, '"', '"', around)
      if (obj === "'") return this.findDelimitedRange(text, c, "'", "'", around)
      if (obj === "(") return this.findDelimitedRange(text, c, "(", ")", around)
      if (obj === "[") return this.findDelimitedRange(text, c, "[", "]", around)
      if (obj === "{") return this.findDelimitedRange(text, c, "{", "}", around)
    }

    return null
  }

  private resolveFtMotion(text: string, cursor: number, type: FtType, char: string): number | null {
    if (type === "f") return this.findCharForward(text, cursor, char)
    if (type === "F") return this.findCharBackward(text, cursor, char)
    if (type === "t") {
      const found = this.findCharForward(text, cursor, char)
      if (found == null) return null
      return Math.max(this.getLineRange(text, cursor).start, found - 1)
    }
    const found = this.findCharBackward(text, cursor, char)
    if (found == null) return null
    return Math.min(this.getLineRange(text, cursor).end, found + 1)
  }

  private reverseFtType(type: FtType): FtType {
    if (type === "f") return "F"
    if (type === "F") return "f"
    if (type === "t") return "T"
    return "t"
  }

  private toRange(cursor: number, target: number, inclusive: boolean): { start: number; end: number } {
    if (target >= cursor) {
      return { start: cursor, end: inclusive ? target + 1 : target }
    }
    return { start: target, end: inclusive ? cursor + 1 : cursor }
  }

  private isWordChar(ch: string | undefined): boolean {
    return !!ch && /[A-Za-z0-9_]/.test(ch)
  }

  private isWhitespace(ch: string | undefined): boolean {
    return ch === " " || ch === "\t" || ch === "\n"
  }

  private isBlank(ch: string | undefined): boolean {
    return ch === " " || ch === "\t"
  }

  private clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n))
  }
}
