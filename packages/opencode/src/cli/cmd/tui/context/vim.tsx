import { createSignal } from "solid-js"
import { createSimpleContext } from "./helper"
import { useTuiConfig } from "./tui-config"
import { VimEngine, type VimMode, type VimKeyEvent, type VimResult } from "../lib/vim-engine"

export const { use: useVim, provider: VimProvider } = createSimpleContext({
  name: "Vim",
  init: () => {
    const config = useTuiConfig()
    const enabled = config.vim ?? false
    const engine = new VimEngine()
    const [mode, setMode] = createSignal<VimMode>(enabled ? "normal" : "insert")

    return {
      get enabled() {
        return enabled
      },
      get mode() {
        return mode()
      },
      handleKey(event: VimKeyEvent, text: string, cursor: number): VimResult {
        if (!enabled) return { consumed: false }
        const result = engine.handleKey(event, text, cursor)
        if (result.modeChange) {
          setMode(result.modeChange)
        }
        return result
      },
      reset() {
        engine.reset()
        setMode(enabled ? "normal" : "insert")
      },
    }
  },
})
