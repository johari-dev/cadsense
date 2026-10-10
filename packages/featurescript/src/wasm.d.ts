/**
 * The slice of the WebAssembly JS API this package uses. Node provides it at runtime, but
 * @types/node doesn't declare it and this package doesn't load the DOM lib.
 * A script file (no imports or exports), so this merges into the global namespace.
 */
declare namespace WebAssembly {
  /** A compiled module; cheap to send to a worker, which instantiates it without recompiling. */
  interface Module {
    readonly __webAssemblyModule?: never;
  }
  interface Instance {
    readonly exports: Record<string, unknown>;
  }
  type Imports = Record<string, Record<string, unknown>>;
  function compile(bytes: ArrayBufferView | ArrayBuffer): Promise<Module>;
  function instantiate(module: Module, imports?: Imports): Promise<Instance>;
}
