import type { Declaration, Module } from "../syntax/Ast.ts";
import type { Diagnostic } from "../syntax/Diagnostic.ts";
import { parseModule } from "../syntax/Parser.ts";
import { sourceFile, type SourceFile } from "../syntax/Source.ts";
import { FsMap, FsTagged, type FsValue, type TypeDef } from "./Value.ts";

export type FunctionNode = Extract<Declaration, { kind: "Function" | "Predicate" }>;
export type OperatorNode = Extract<Declaration, { kind: "Operator" }>;
export type ConstNode = Extract<Declaration, { kind: "Const" }>;

/** A top-level function or predicate. Same-named ones across visible modules form one overload set. */
export interface Callable {
  readonly kind: "callable";
  readonly node: FunctionNode;
  readonly module: ModuleInstance;
  readonly exported: boolean;
}

/** A top-level constant, evaluated on first use. */
export interface ConstSlot {
  readonly kind: "const";
  readonly node: ConstNode;
  readonly module: ModuleInstance;
  readonly exported: boolean;
  state: "pending" | "evaluating" | "done";
  value: FsValue;
}

export interface TypeSlot {
  readonly kind: "type" | "enum";
  readonly def: TypeDef;
  readonly module: ModuleInstance;
  readonly exported: boolean;
}

export type TopLevel = Callable | ConstSlot | TypeSlot;

export interface Operator {
  readonly node: OperatorNode;
  readonly module: ModuleInstance;
}

interface Import {
  readonly module: ModuleInstance;
  readonly namespace: string | null;
  readonly exported: boolean;
}

/** One parsed module and the declarations it owns. */
export class ModuleInstance {
  readonly path: string;
  readonly file: SourceFile;
  readonly ast: Module;
  readonly own = new Map<string, TopLevel[]>();
  readonly imports: Import[] = [];
  /** Std modules may call `@builtins`; user modules may not. */
  readonly isStd: boolean;
  /** Name lookups, cached; see `ModuleLoader.lookup`. */
  readonly lookups = new Map<string, readonly TopLevel[]>();
  /** Modules whose exports this module re-exports, including itself. Computed on demand. */
  reach: readonly ModuleInstance[] | undefined;

  /**
   * An import of another Onshape document (by element id) that isn't available locally. It
   * declares nothing; a name looked up through it fails where it's used, naming the element.
   */
  readonly unavailable: boolean;

  constructor(path: string, file: SourceFile, ast: Module, isStd: boolean, unavailable = false) {
    this.path = path;
    this.file = file;
    this.ast = ast;
    this.isStd = isStd;
    this.unavailable = unavailable;
  }
}

/**
 * An import path naming an element of an Onshape document: `elementId`, or
 * `documentId/versionId/elementId`, each 24 hex digits.
 */
export const isOnshapeElementPath = (path: string): boolean =>
  /^[0-9a-f]{24}(?:\/[0-9a-f]{24}){0,2}$/i.test(path);

/** A module that failed to parse, or imports one that doesn't exist. */
export class ModuleLoadError extends Error {
  readonly path: string;
  readonly file: SourceFile | null;
  readonly diagnostics: readonly Diagnostic[];
  constructor(
    path: string,
    file: SourceFile | null,
    diagnostics: readonly Diagnostic[],
    message: string,
  ) {
    super(message);
    this.name = "ModuleLoadError";
    this.path = path;
    this.file = file;
    this.diagnostics = diagnostics;
  }
}

export const STD_PREFIX = "onshape/std/";

/**
 * Loads modules and resolves names between them. `read` returns a module's source by import path:
 * `onshape/std/x.fs` for std, anything else for user modules.
 */
export class ModuleLoader {
  private readonly read: (path: string) => string | undefined;
  private readonly modules = new Map<string, ModuleInstance>();
  private readonly enumValues = new Map<TypeDef, FsMap>();
  private nextTypeOrder = 0;
  /** Operator overloads from every loaded module, by operator. */
  readonly operators = new Map<string, Operator[]>();

  constructor(read: (path: string) => string | undefined) {
    this.read = read;
  }

  /** Loads `path` and everything it imports. Throws `ModuleLoadError` on syntax errors or missing imports. */
  load(path: string, source?: string): ModuleInstance {
    // Std is shared by every run of a warm runtime, so its source only ever comes from `read`.
    if (source !== undefined && path.startsWith(STD_PREFIX))
      throw new ModuleLoadError(
        path,
        null,
        [],
        `${path} is a standard library path; a script can't be loaded there.`,
      );
    const existing = this.modules.get(path);
    if (existing) return existing;
    const text = source ?? this.read(path);
    if (text === undefined) throw new ModuleLoadError(path, null, [], `Module ${path} not found.`);
    const file = sourceFile(path, text);
    const { module: ast, diagnostics } = parseModule(file);
    if (diagnostics.length)
      throw new ModuleLoadError(
        path,
        file,
        diagnostics,
        `${path} has ${diagnostics.length} syntax error(s).`,
      );
    const instance = new ModuleInstance(path, file, ast, path.startsWith(STD_PREFIX));
    // Register before loading imports: std's import graph has cycles.
    this.modules.set(path, instance);
    for (const node of ast.declarations) this.addDeclaration(instance, node);
    for (const node of ast.declarations) {
      if (node.kind !== "Import") continue;
      let imported: ModuleInstance;
      try {
        imported = this.load(node.path);
      } catch (error) {
        if (!(error instanceof ModuleLoadError && error.file === null)) throw error;
        // Icons, images and libraries from other Onshape documents can't be fetched here.
        if (!isOnshapeElementPath(node.path))
          throw new ModuleLoadError(
            path,
            file,
            [
              {
                code: "unresolved-import",
                message: `Cannot import ${node.path}.`,
                span: node.span,
              },
            ],
            error.message,
          );
        imported = this.unavailableModule(node.path);
      }
      if (node.namespace.length > 1)
        throw new ModuleLoadError(
          path,
          file,
          [
            {
              code: "unresolved-import",
              message: "Nested import namespaces are not supported.",
              span: node.span,
            },
          ],
          "Nested namespace",
        );
      instance.imports.push({
        module: imported,
        namespace: node.namespace[0] ?? null,
        exported: node.exported,
      });
    }
    return instance;
  }

  /** The stand-in for an Onshape element import that can't be read; see `ModuleInstance.unavailable`. */
  private unavailableModule(path: string): ModuleInstance {
    const existing = this.modules.get(path);
    if (existing) return existing;
    const file = sourceFile(path, "");
    const instance = new ModuleInstance(
      path,
      file,
      { version: null, declarations: [] },
      false,
      true,
    );
    this.modules.set(path, instance);
    return instance;
  }

  get loaded(): Iterable<ModuleInstance> {
    return this.modules.values();
  }

  /**
   * Forgets every user module and its operators, so a long-lived loader reads edited sources (and
   * drops modules a failed load left half-registered) while std stays loaded. Std never imports
   * user modules, so nothing that stays refers to what goes.
   */
  unloadUserModules(): void {
    for (const [path, module] of this.modules) if (!module.isStd) this.modules.delete(path);
    for (const [operator, list] of this.operators)
      this.operators.set(
        operator,
        list.filter((entry) => entry.module.isStd),
      );
  }

  private addDeclaration(module: ModuleInstance, node: Declaration) {
    const add = (name: string, entry: TopLevel) => {
      const list = module.own.get(name);
      if (list) list.push(entry);
      else module.own.set(name, [entry]);
    };
    switch (node.kind) {
      case "Import":
        return;
      case "Function":
      case "Predicate":
        return add(node.name, { kind: "callable", node, module, exported: node.exported });
      case "Const":
        return add(node.name, {
          kind: "const",
          node,
          module,
          exported: node.exported,
          state: "pending",
          value: undefined,
        });
      case "Operator": {
        const list = this.operators.get(node.operator) ?? [];
        list.push({ node, module });
        this.operators.set(node.operator, list);
        return;
      }
      case "Type":
      case "Enum": {
        const members = node.kind === "Enum" ? node.members.map((m) => m.name) : [];
        const def: TypeDef = {
          name: node.name,
          kind: node.kind === "Enum" ? "enum" : "type",
          module: module.path,
          order: this.nextTypeOrder++,
          members,
          ordinals: new Map(members.map((name, i) => [name, i])),
        };
        return add(node.name, { kind: def.kind, def, module, exported: node.exported });
      }
    }
  }

  /** Modules reachable from `module` through `export import`, including itself. */
  private reachOf(module: ModuleInstance): readonly ModuleInstance[] {
    if (module.reach) return module.reach;
    const seen = new Set<ModuleInstance>([module]);
    const queue = [module];
    for (let i = 0; i < queue.length; i++)
      for (const imp of queue[i]!.imports)
        if (imp.exported && imp.namespace === null && !seen.has(imp.module)) {
          seen.add(imp.module);
          queue.push(imp.module);
        }
    return (module.reach = queue);
  }

  /** What `module` exports under `name`: its own exported declarations and those it re-exports. */
  private exportsOf(module: ModuleInstance, name: string): TopLevel[] {
    const out: TopLevel[] = [];
    for (const m of this.reachOf(module))
      for (const entry of m.own.get(name) ?? []) if (entry.exported) out.push(entry);
    return out;
  }

  /**
   * Every declaration `name` can refer to inside `module`: its own declarations plus the exports of
   * its imports (or of one namespaced import). Duplicates reached along several paths appear once.
   */
  lookup(
    module: ModuleInstance,
    name: string,
    namespace: readonly string[] = [],
  ): readonly TopLevel[] {
    const cacheKey = namespace.length ? `${namespace.join("::")}::${name}` : name;
    const cached = module.lookups.get(cacheKey);
    if (cached) return cached;
    const found = new Set<TopLevel>();
    if (namespace.length === 0) {
      for (const entry of module.own.get(name) ?? []) found.add(entry);
      for (const imp of module.imports)
        if (imp.namespace === null)
          for (const entry of this.exportsOf(imp.module, name)) found.add(entry);
    } else
      for (const imp of module.imports)
        if (imp.namespace === namespace[0])
          for (const entry of this.exportsOf(imp.module, name)) found.add(entry);
    const result = [...found];
    module.lookups.set(cacheKey, result);
    return result;
  }

  /** The map an enum name evaluates to: member name to tagged member value. */
  enumValue(def: TypeDef): FsMap {
    let value = this.enumValues.get(def);
    if (!value) {
      value = FsMap.fromEntries(
        def.members.map((member) => [member, new FsTagged(def, member)] as const),
      );
      this.enumValues.set(def, value);
    }
    return value;
  }
}
