import { createContext, Show, useContext, type ParentProps } from "solid-js"

export function createSimpleContext<T, Props extends Record<string, any>>(input: {
  name: string
  init: ((input: Props) => T) | (() => T)
}) {
  const ctx = createContext<T>()

  return {
    /**
     * The raw context, for callers that already hold a value and must not run
     * `init`.
     *
     * The providers here bootstrap for real — `Sync` talks to the server, `KV`
     * reads the user's `kv.json` — which is correct in the app and wrong
     * anywhere a component is rendered against fixtures. Exposing the context
     * lets such a caller supply a value directly instead of the alternative,
     * which is a parallel set of hooks the components would have to be written
     * against and would then drift from the real ones.
     */
    context: ctx,
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      return (
        // @ts-expect-error
        <Show when={init.ready === undefined || init.ready === true}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      )
    },
    use() {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}
