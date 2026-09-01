# Client Runtime

Shared behavior for the desktop renderer. Public APIs are organized by package
subpath; the package intentionally has no root export.

## Public subpaths

| Subpath               | Responsibility                                                   |
| --------------------- | ---------------------------------------------------------------- |
| `authorization`       | Local bearer bootstrap and WebSocket ticket authorization        |
| `connection`          | Local targets, supervision, retries, and environment registry    |
| `environment`         | Environment identity, descriptors, endpoints, and scoped keys    |
| `errors`              | Shared client error inspection                                   |
| `operations`          | Multi-step application workflows                                 |
| `operations/projects` | Multi-step project creation workflows                            |
| `platform`            | Desktop capability and local-cache persistence contracts         |
| `rpc`                 | HTTP/RPC clients, protocol, sessions, and subscriptions          |
| `state/<domain>`      | Focused shared state, retention, reducers, and Atom constructors |

## Dependency direction

The desktop renderer provides `platform` services. `connection` composes those
capabilities with `authorization` and `rpc` to supervise local environment
sessions. Independent `state` modules consume the connection registry and expose
focused state or Atom constructors to application-owned runtimes.

Applications should import the narrowest relevant subpath. There is no broad
`state` export: use domain paths such as `state/shell`, `state/threads`, or
Subpath indices and explicitly exported domain files are public
API boundaries; all other files remain implementation details.
