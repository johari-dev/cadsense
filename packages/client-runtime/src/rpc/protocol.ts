import { WsRpcGroup } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/unstable/rpc";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
export type WsRpcProtocolClient = Effect.Success<typeof makeWsRpcProtocolClient>;
