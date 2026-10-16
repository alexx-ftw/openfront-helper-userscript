# server

> [← back](../index.md)

├── [telemetry/](./telemetry/index.md) — 3 files
├── [AdminBotRoutes.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/AdminBotRoutes.ts)
├── [Archive.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/Archive.ts)
├── [Censor.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/Censor.ts)
├── [Client.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/Client.ts)
├── [ClientMsgRateLimiter.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/ClientMsgRateLimiter.ts) — A rejoin makes the server serialize and send the turn histor
├── [ClusterCheckin.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/ClusterCheckin.ts) — Multi-server v2 (docs/MultiServer.md, "Server list v2"): eve
├── [ConfigPatch.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/ConfigPatch.ts) — The host edits its lobby through update_game_config, which c
├── [Consensus.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/Consensus.ts) — The simulation runs on the clients, so the outcomes the serv
├── [CustomTribes.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/CustomTribes.ts) — TribeSchema is loose: extra per-tribe fields the API sends p
├── [DesktopRelease.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/DesktopRelease.ts) — Bump ONLY when a client genuinely cannot run on an older des
├── [DesyncDetector.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/DesyncDetector.ts) — Desync detection. The simulation runs on every client; each 
├── [GameApiCors.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/GameApiCors.ts)
├── [GameManager.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/GameManager.ts)
├── [GamePreviewBuilder.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/GamePreviewBuilder.ts)
├── [GamePreviewRoute.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/GamePreviewRoute.ts)
├── [GameServer.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/GameServer.ts)
├── [IPCBridgeSchema.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/IPCBridgeSchema.ts)
├── [IntentAuthorization.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/IntentAuthorization.ts)
├── [JoinVerify.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/JoinVerify.ts)
├── [ListingState.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/ListingState.ts) — A private lobby's presence in the public lobby browser: whet
├── [LobbyCoordinatorClient.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/LobbyCoordinatorClient.ts)
├── [LobbyQueuePayment.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/LobbyQueuePayment.ts)
├── [Logger.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/Logger.ts)
├── [MapLandTiles.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/MapLandTiles.ts)
├── [MapPlaylist.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/MapPlaylist.ts)
├── [Master.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/Master.ts)
├── [MasterLobbyService.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/MasterLobbyService.ts)
├── [MatchTelemetryRecorder.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/MatchTelemetryRecorder.ts) — One match's view of the telemetry stream: stamps every event
├── [NameVisibility.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/NameVisibility.ts) — Who may see whose real identity, and what each viewer is sho
├── [NoStoreHeaders.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/NoStoreHeaders.ts)
├── [OtelResource.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/OtelResource.ts)
├── [PollingLoop.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/PollingLoop.ts)
├── [PoolRouting.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/PoolRouting.ts) — Which member of a lobby pool a player belongs to. See PoolCo
├── [Privilege.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/Privilege.ts)
├── [PrivilegeRefresher.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/PrivilegeRefresher.ts)
├── [PublicAssetManifest.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/PublicAssetManifest.ts)
├── [README.md](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/README.md) — Gatekeeper
├── [RankedCheckin.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/RankedCheckin.ts) — The ranked (matchmaking) side of the drain, the counterpart 
├── [Rejoin.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/Rejoin.ts) — Hands a "rejoin" message's socket to the client's game, or c
├── [RenderDesktopDescriptor.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/RenderDesktopDescriptor.ts) — Builds the desktop (Steam) release descriptor at DEPLOY time
├── [RenderHtml.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/RenderHtml.ts)
├── [RenderStaticIndex.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/RenderStaticIndex.ts) — Renders the app shell exactly as the running server would - 
├── [Roster.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/Roster.ts) — Who is in the game: everyone who ever joined, who is connect
├── [RuntimeAssetManifest.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/RuntimeAssetManifest.ts)
├── [Server.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/Server.ts) — Load environment variables before we read configuration valu
├── [ServerEnv.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/ServerEnv.ts)
├── [SingleplayerPresence.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/SingleplayerPresence.ts) — A singleplayer game runs entirely in the browser: this worke
├── [SocketIngress.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/SocketIngress.ts)
├── [StaticAssetCache.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/StaticAssetCache.ts)
├── [VoteTally.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/VoteTally.ts) — IP-weighted single-round vote used to reach consensus on a v
├── [Worker.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/Worker.ts)
├── [WorkerLobbyService.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/WorkerLobbyService.ts)
├── [WorkerMetrics.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/WorkerMetrics.ts)
├── [WorkerPathPrefix.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/WorkerPathPrefix.ts)
└── [jwt.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/src/server/jwt.ts)
