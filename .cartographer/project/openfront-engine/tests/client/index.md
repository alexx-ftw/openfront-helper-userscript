# client

> [← back](../index.md)

├── [clan/](./clan/index.md) — 16 files
├── [components/](./components/index.md) — 17 files
├── [controllers/](./controllers/index.md) — 5 files
├── [graphics/](./graphics/index.md) — 23 files
├── [render/](./render/index.md) — 5 files
├── [sound/](./sound/index.md) — 3 files
├── [view/](./view/index.md) — 3 files
├── [AccountGameStatsNavigation.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/AccountGameStatsNavigation.test.ts)
├── [AccountIdentity.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/AccountIdentity.test.ts)
├── [AccountModal.rendering.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/AccountModal.rendering.test.ts) — ─── Mocks (mirrors tests/client/clan/ClanModalTestUtils.ts f
├── [AccountSettingsModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/AccountSettingsModal.test.ts)
├── [ApexNavigation.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ApexNavigation.test.ts)
├── [ApiPlayerLeaderboard.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ApiPlayerLeaderboard.test.ts) — fetchPlayerLeaderboard is unauthenticated; Auth is only mock
├── [ApiTribeLeaderboard.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ApiTribeLeaderboard.test.ts) — fetchTribeLeaderboard is unauthenticated; Auth is only mocke
├── [Auth.desktopLogin.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/Auth.desktopLogin.test.ts)
├── [Auth.steam.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/Auth.steam.test.ts)
├── [Auth.steamOpenId.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/Auth.steamOpenId.test.ts) — "Sign in through Steam" and web-initiated Steam linking (OPE
├── [AuthRefreshFailure.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/AuthRefreshFailure.test.ts) — Only a 401 from /auth/refresh means the session is dead. A 5
├── [AuthRefreshTimeout.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/AuthRefreshTimeout.test.ts) — The bound Auth.ts already applies to /auth/steam (see doStea
├── [AuthSessionActive.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/AuthSessionActive.test.ts)
├── [BannedModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/BannedModal.test.ts) — translateText stand-in that mirrors the real one's key-resol
├── [BoostTribeNameBadRequest.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/BoostTribeNameBadRequest.test.ts)
├── [BootInterruptSequencing.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/BootInterruptSequencing.test.ts)
├── [BootInterruptSequencingCrazyGames.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/BootInterruptSequencingCrazyGames.test.ts)
├── [BootInterrupts.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/BootInterrupts.test.ts)
├── [ChatModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ChatModal.test.ts)
├── [ClanGameStatsNavigation.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ClanGameStatsNavigation.test.ts)
├── [ClanTeamLabel.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ClanTeamLabel.test.ts)
├── [ClientEnvSiteOrigin.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ClientEnvSiteOrigin.test.ts) — siteOrigin() names the WEBSITE a page belongs to, for links 
├── [ClientEnvStatic.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ClientEnvStatic.test.ts) — Multi-server v2, roadmap item 2 (docs/MultiServer.md): the p
├── [ClientGameRunnerActions.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ClientGameRunnerActions.test.ts) — ClientGameRunner's left-click handling: spawn intents during
├── [ClientGameRunnerMessages.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ClientGameRunnerMessages.test.ts) — ClientGameRunner's server-message handling, driven through c
├── [ClientPlatform.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ClientPlatform.test.ts)
├── [ControlPanelAttackRatio.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ControlPanelAttackRatio.test.ts) — Side-effect import: the @customElement decorator registers <
├── [CosmeticCard.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CosmeticCard.test.ts)
├── [CosmeticFlagValidation.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CosmeticFlagValidation.test.ts)
├── [CosmeticLocalization.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CosmeticLocalization.test.ts)
├── [CosmeticLockerIntegration.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CosmeticLockerIntegration.test.ts)
├── [CosmeticPackPurchase.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CosmeticPackPurchase.test.ts)
├── [CosmeticPreview.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CosmeticPreview.test.ts)
├── [CosmeticPurchaseCompletion.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CosmeticPurchaseCompletion.test.ts)
├── [CosmeticPurchaseDebt.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CosmeticPurchaseDebt.test.ts) — POST /shop/purchase is the highest-traffic spend path (every
├── [CosmeticPurchaseNaming.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CosmeticPurchaseNaming.test.ts)
├── [CosmeticVisibility.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CosmeticVisibility.test.ts)
├── [CosmeticsFetchTimeout.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CosmeticsFetchTimeout.test.ts)
├── [CosmeticsPaymentsMigration.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CosmeticsPaymentsMigration.test.ts)
├── [CreatorCode.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CreatorCode.test.ts)
├── [CreatorCodeDeepLink.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CreatorCodeDeepLink.test.ts)
├── [CreatorCodePanel.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CreatorCodePanel.test.ts) — vi.hoisted because vi.mock is hoisted above the imports: the
├── [CustomCurrencyCard.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/CustomCurrencyCard.test.ts)
├── [DetailedGameViewFilters.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/DetailedGameViewFilters.test.ts)
├── [DifficultyInfo.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/DifficultyInfo.test.ts)
├── [DisableSafariPinchZoom.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/DisableSafariPinchZoom.test.ts)
├── [DoomsdayModifierBadge.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/DoomsdayModifierBadge.test.ts) — The doomsday clock is part of the public "special" modifier 
├── [EffectScene.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/EffectScene.test.ts)
├── [EffectsGrid.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/EffectsGrid.test.ts)
├── [GameInfoView.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/GameInfoView.test.ts)
├── [GameMetrics.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/GameMetrics.test.ts)
├── [GameRightSidebar.fullscreen.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/GameRightSidebar.fullscreen.test.ts)
├── [GameServerApiCallers.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/GameServerApiCallers.test.ts)
├── [GameServerApiUrls.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/GameServerApiUrls.test.ts)
├── [GameStatsModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/GameStatsModal.test.ts)
├── [GameVersion.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/GameVersion.test.ts)
├── [GrantedSubscriptionPurchase.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/GrantedSubscriptionPurchase.test.ts) — OPE-440. Every Steam base-app buyer gets a GRANTED month: a 
├── [GroupTokenPresence.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/GroupTokenPresence.test.ts)
├── [HostLobbyModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/HostLobbyModal.test.ts) — The desktop bridge is absent in a browser and in jsdom. Mock
├── [HostLobbyModalKickPlayer.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/HostLobbyModalKickPlayer.test.ts) — The desktop bridge is absent in jsdom; mock it like HostLobb
├── [HostLobbyModalTeamCount.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/HostLobbyModalTeamCount.test.ts) — The desktop bridge is absent in jsdom; mock it like HostLobb
├── [InGameKeybindCapture.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/InGameKeybindCapture.test.ts)
├── [InGameSettingsMenu.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/InGameSettingsMenu.test.ts)
├── [InlineCheckout.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/InlineCheckout.test.ts) — Linked email by default, so ordinary tests exercise the no-e
├── [InputHandlerGestureZoom.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/InputHandlerGestureZoom.test.ts)
├── [InventoryLoadoutBar.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/InventoryLoadoutBar.test.ts)
├── [InventoryModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/InventoryModal.test.ts)
├── [InventoryNavigation.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/InventoryNavigation.test.ts)
├── [InventoryRetryCache.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/InventoryRetryCache.test.ts)
├── [JoinLobbyModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/JoinLobbyModal.test.ts) — The desktop bridge is absent in a browser and in jsdom. Mock
├── [LangSelectorDefaultLocale.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/LangSelectorDefaultLocale.test.ts) — defaultLocale is private; drive it through a cast, the same 
├── [LangSelectorTranslate.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/LangSelectorTranslate.test.ts) — applyTranslation/changeLanguage are private; drive them thro
├── [LazyCosmeticGrids.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/LazyCosmeticGrids.test.ts) — Stubbed before the modules under test create their shared ob
├── [LeaderboardModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/LeaderboardModal.test.ts)
├── [LeaderboardTribeTable.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/LeaderboardTribeTable.test.ts) — Keys pass through with their params inlined so assertions ca
├── [LinkResult.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/LinkResult.test.ts)
├── [ListLobbyDialog.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ListLobbyDialog.test.ts)
├── [LobbyCardTrust.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/LobbyCardTrust.test.ts)
├── [LocalServer.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/LocalServer.test.ts)
├── [LocalServerEdge.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/LocalServerEdge.test.ts)
├── [LocalServerReplaySpeed.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/LocalServerReplaySpeed.test.ts)
├── [LoginResult.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/LoginResult.test.ts)
├── [MainInitialize.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/MainInitialize.test.ts)
├── [MarketingConsentToast.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/MarketingConsentToast.test.ts)
├── [Matchmaking.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/Matchmaking.test.ts)
├── [MultiTabModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/MultiTabModal.test.ts)
├── [NavAccountButton.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/NavAccountButton.test.ts)
├── [NavAccountMenu.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/NavAccountMenu.test.ts)
├── [NavBars.settings.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/NavBars.settings.test.ts) — jsdom has no ResizeObserver, and the mobile top bar shares a
├── [NavNotifications.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/NavNotifications.test.ts)
├── [NavUtilityIcons.quit.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/NavUtilityIcons.quit.test.ts)
├── [NewsMarkdown.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/NewsMarkdown.test.ts)
├── [NewsModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/NewsModal.test.ts) — Side-effect import registers <news-modal>; a type-only impor
├── [OvertimePanel.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/OvertimePanel.test.ts) — Keys pass through with their params appended, so assertions 
├── [Payments.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/Payments.test.ts)
├── [PaymentsCheckout.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PaymentsCheckout.test.ts)
├── [PaymentsInline.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PaymentsInline.test.ts)
├── [Platform.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/Platform.test.ts)
├── [PlayPageTopBar.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PlayPageTopBar.test.ts)
├── [PlayerName.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PlayerName.test.ts)
├── [PlayerProfileClansTab.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PlayerProfileClansTab.test.ts)
├── [PlayerProfileModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PlayerProfileModal.test.ts)
├── [PlayerRow.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PlayerRow.test.ts)
├── [PlayerStatsSummary.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PlayerStatsSummary.test.ts)
├── [PlayerStatsTable.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PlayerStatsTable.test.ts) — Render each label as its own key so a column can be matched 
├── [PlayerStatsTreeMerge.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PlayerStatsTreeMerge.test.ts)
├── [ProfileGameStatsNavigation.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ProfileGameStatsNavigation.test.ts)
├── [PurchaseButton.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PurchaseButton.test.ts)
├── [PurchaseCosmeticPack.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PurchaseCosmeticPack.test.ts)
├── [PurchaseNudgeModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PurchaseNudgeModal.test.ts)
├── [PurchaseReturn.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/PurchaseReturn.test.ts)
├── [RankingControls.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/RankingControls.test.ts)
├── [ResolveGameHost.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ResolveGameHost.test.ts) — The per-game routing decision (docs/MultiServer.md, PR 5): a
├── [ServerHttpBase.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ServerHttpBase.test.ts) — deriveServerHttpBase resolves the origin of the game server'
├── [ServerList.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ServerList.test.ts)
├── [ServerWsBase.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ServerWsBase.test.ts) — deriveServerWsBase resolves the game-server WebSocket origin
├── [ShareBase.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ShareBase.test.ts) — These two answer "where should a link that LEAVES this clien
├── [ShareLinks.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/ShareLinks.test.ts)
├── [SinglePlayerModalStart.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/SinglePlayerModalStart.test.ts)
├── [SinglePlayerStartFeedback.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/SinglePlayerStartFeedback.test.ts)
├── [SingleplayerHeartbeat.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/SingleplayerHeartbeat.test.ts) — The heartbeat is the server's only sign a singleplayer game 
├── [SocketClose.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/SocketClose.test.ts)
├── [SteamGrantNotices.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/SteamGrantNotices.test.ts)
├── [SteamHandoff.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/SteamHandoff.test.ts)
├── [SteamHandoffModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/SteamHandoffModal.test.ts)
├── [SteamLink.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/SteamLink.test.ts) — redeemSteamLink is authenticated; Auth is only mocked becaus
├── [SteamLinkModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/SteamLinkModal.test.ts) — ─── Mocks ──────────────────────────────────────────────────
├── [StoreAuthPending.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/StoreAuthPending.test.ts) — The store's own network is out of scope here: the tribes pan
├── [StoreModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/StoreModal.test.ts)
├── [StripeInline.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/StripeInline.test.ts)
├── [StripeInlineSession.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/StripeInlineSession.test.ts)
├── [SubscriptionPanel.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/SubscriptionPanel.test.ts)
├── [SubscriptionPolicy.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/SubscriptionPolicy.test.ts) — Lead decision of 6 Sept 2026 (infra OPE-230), pending Josh. 
├── [Telemetry.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/Telemetry.test.ts)
├── [TempTokenLogin.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/TempTokenLogin.test.ts)
├── [TokenLoginModal.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/TokenLoginModal.test.ts)
├── [TransformHandler.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/TransformHandler.test.ts)
├── [TransportConnectionRefused.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/TransportConnectionRefused.test.ts)
├── [TransportFrameLogging.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/TransportFrameLogging.test.ts) — OPE-423. Transport's onmessage catch used to log the raw fra
├── [TransportPoolRedirect.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/TransportPoolRedirect.test.ts)
├── [TransportReconnect.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/TransportReconnect.test.ts)
├── [TransportSendPaths.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/TransportSendPaths.test.ts)
├── [TribeNameDebt.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/TribeNameDebt.test.ts) — The shared spend helper in the API returns
├── [TribeNameDebtEndToEnd.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/TribeNameDebtEndToEnd.test.ts) — The one test that spans the whole path: the real panel over 
├── [TribesPanelDebt.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/TribesPanelDebt.test.ts) — What a player in debt actually ends up looking at. The Api-l
├── [TrustedJoinGate.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/TrustedJoinGate.test.ts) — Same socket stand-in as GameModeSelectorGatingWiring: keep t
├── [TurnstileToken.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/TurnstileToken.test.ts)
├── [UpdateUsername.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/UpdateUsername.test.ts)
├── [UserMeFetchTimeout.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/UserMeFetchTimeout.test.ts)
├── [UserSettingModal.audio.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/UserSettingModal.audio.test.ts)
├── [UserSettingModal.display.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/UserSettingModal.display.test.ts)
├── [UserSettingModal.graphics.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/UserSettingModal.graphics.test.ts)
├── [UserSettingModal.tabs.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/UserSettingModal.tabs.test.ts)
├── [UserSettingModalValues.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/UserSettingModalValues.test.ts) — The easter-egg controls only render on Gameplay after the ko
├── [UsernameBareClaim.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/UsernameBareClaim.test.ts) — The panel reaches the API and the in-game dialog; stub both 
├── [UsernameClaimPrefill.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/UsernameClaimPrefill.test.ts) — Same boundary stubs as UsernameBareClaim.test.ts — the panel
├── [UsernameInput.steam.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/UsernameInput.steam.test.ts)
├── [UsernameInputValidation.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/UsernameInputValidation.test.ts) — Same boundary stubs as tests/UsernameInput.test.ts: the iden
├── [UsernameVerifiedRoute.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/UsernameVerifiedRoute.test.ts)
├── [Utils.mapKey.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/Utils.mapKey.test.ts)
├── [UtilsUuid.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/UtilsUuid.test.ts)
└── [initGL.test.ts](/home/eros/Desktop/openfront-helper-userscript/openfront-engine/tests/client/initGL.test.ts) — WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL
