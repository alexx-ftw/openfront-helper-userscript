# Auditoría y extracción para el bot híbrido

Fecha: 2026-10-11. Alcance: seis repositorios compartidos, ramas principales y
ramas avanzadas relevantes. Se inventariaron árboles y ramas; se siguieron implementaciones activas,
contratos de observación/acciones, modelos, integración y pruebas. Inventariar una
rama no implica validar semánticamente todos sus archivos ni ejecutar su motor.
Las cifras de rendimiento de terceros son declaraciones del autor salvo indicación
expresa; no se ejecutaron sus entrenamientos, servicios ni bots online.

## Revisiones verificadas

| Proyecto           | Revisión                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| AggroBot           | [`62e1e78`](https://github.com/SLP-DEV1/openfront-bot/tree/62e1e78fa2a4f29adb04284c852f8eef96dcce15)              |
| OpenFront Intel    | [`5043074`](https://github.com/redreamality/openfront-intel/tree/50430748acf3fb5f23c033dfa21c3ecbe6251c4f)        |
| Leo, main          | [`e60abae`](https://github.com/LeoBaldachino/OpenFrontIOai/tree/e60abae84860341f6070b407240343a57ab117fe)         |
| Leo, rama avanzada | [`60b10bc`](https://github.com/LeoBaldachino/OpenFrontIOai/tree/60b10bcfafd78826e5245bc3c79430a881c0984b)         |
| Generative, main   | [`7b52b78`](https://github.com/CptFunkymonk/OpenFrontIO-Generative/tree/7b52b788dfa1f789fbdf7d06bc2c91a6d24cc683) |
| Generative, Apex   | [`3de4b47`](https://github.com/CptFunkymonk/OpenFrontIO-Generative/tree/3de4b47cad875a0a9a5868940d7d7743c421e320) |
| djmango            | [`4745363`](https://github.com/djmango/openfront-ai/tree/474536340480659c53d9a9e497b08fa1fefb9589)                |
| OpenFrontMind      | [`fcbf444`](https://github.com/x3rdev/openfrontmind/tree/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3)                |

## AggroBot: políticas distintas, control opcional y recibos

Run3 embebe un checkpoint real Schema 4, `24x24x16-tanh`, con 1.000 pesos no
cero. Sus 16 salidas modifican prioridades y umbrales de los planificadores, no son
órdenes ejecutables. “Learn” es otro mecanismo: cada 240 ticks acumula una media por
contexto de cambios de territorio/tropas y ajusta agresividad/reserva, con bypass de
emergencia. No entrena esos pesos. Sí existen entrenadores offline: mutación
estratégica y gradiente para candidatos; no se ejecutaron en esta auditoría.

Schemas 5/6 puntúan candidatos existentes por ganancia/riesgo. Con
`shadowRankEnabled` y `candidateControlEnabled`, las variantes raw/calibrated/
adaptive/rank/gated pueden cambiar el orden y el candidato seleccionado. Schema 7
puntúa ramas con 38 features; `chooseActionBranch` y `steerForBranch` pueden elegir
esperar o priorizar un canal/objetivo cuando se activa su control. Las funciones que
emiten todavía aplican sus guards. Las etiquetas `legal:true` del adaptador de
ramas no son una confirmación del motor. Ranking/control están apagados por defecto;
`learningEnabled` y `autoStart` están encendidos. No confundir Learn con CONTROL.

El archivo candidate-v5-v2 tiene 702 pesos no cero; el holdout tiene 702 pesos y
sólo dos no cero. Los placeholders del bundle son null por defecto y su manifest
v5-v2 declara `liveDeployment:false`. Por tanto, «sin parámetros» describe esos
placeholders, no todos sus modelos. El manifest cita dataset, evidencia de departure
y un test que no están en el árbol fijado: sus porcentajes no se reproducen desde
ese manifest ni prueban victorias.

Hay dos criterios de promoción distintos. `evaluation-v2.compare`, llamado por
`train.mjs`, permite mejoras sostenidas de supervivencia/territorio sin más
victorias. Un probe con dos pares truncados reproduce `promoted:true` y cero
victorias en ambos brazos. `promotion-gate-v5` es más estricto: candidate/rule-basis/
Run3, procedencia, grabación completa, resultados verificados, partidas terminadas y
cobertura por mapas/perfiles/celdas. Su existencia no convierte la promoción antigua
en una certificación ni activa promoción automática en nuestro evaluador.

Cinco extracciones concretas, mediante implementación propia:

| Idea y condición                                                                                                                   | Qué ya tenemos                                                                             | Delta condicionado y prueba antes de controlar                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate por partidas completas y celdas preregistradas: baseline/candidato misma semilla, modelo congelado y no regresión por cohorte | Evaluador pareado, fingerprints, exclusiones de horizonte/fallos y victorias terminadas    | Añadir cobertura declarada y diagnóstico por celda; no copiar umbrales como certificado universal. Probar missing/duplicate pairs, contaminación y celda degradada. No promover automáticamente.                                       |
| Recovery por ingreso observado: cero train/trade, core productivo insuficiente o probes repetidamente fallidos; invasión/nuke veto | StructureBehavior prioriza core/Ports/SAM y protege reservas; pending ledger de tropas     | Sólo añadir detector de drought y cuotas de oro compartidas si trazas reales muestran bloqueo u overspend. Desconocido no es cero; quote SAM urgente nunca se libera. Probar cambio de precio/amenaza tras await y doble gasto.        |
| Ledger naval con ETA observada y riesgo local que caduca                                                                           | Intercepción geométrica, target-selection del motor, busy ticks y assignments persistentes | Conservar arribos sin confirmar hasta ventana derivada de MotionPlan; no desaparición=hundimiento. Probar rutas largas, recall, ownership tardío y riesgo de una costa que no bloquea todas. Su BFS limitado no sustituye ruta nativa. |
| Joint plan con objetivo, ack, strikeTick y expiry, sólo entre aliados reales                                                       | Companion/SpawnObjective y compromisos visibles/pending                                    | Si hace falta acuerdo explícito, añadirlo al estado existente, sin otro relay/emisor. Revalidar reservas/alianza al ejecutar; peer stale o sin ack expira. Probar protocolo legado, nueva crisis y presupuestos inconsistentes.        |
| Spawn core+anillos y banda aliada sin superposición                                                                                | Índice/heatmap de spawn, terreno, clan/proximidad y crecimiento                            | Solapamiento alto: probar sólo bandas/densidad por mapa/modo, sin copiar pesos. Full footprint y distancia nativa siguen siendo veto; probar islas pequeñas, crowded spawns, aliados demasiado próximos y presupuesto de búsqueda.     |

Funciones auditadas: `spendBudget`, `economy` y su revalidación tras awaits;
`confirmAttack`, `frontRiskPlan`, `navalRouteAssessment`, `inspectMarine`,
`diplomacyScore`, `spawnScore`, `duoJointOpportunity` y `coordinateDuo`.
`send` prueba emisión al bus, no aceptación. El contador
`engineConfirmedDifferences` incrementa por coincidencia de canal, sin recibo
nativo; un probe sin motor reproduce el incremento. El diagnóstico
`neuralDelta=gain*rawScore` tampoco refleja todas las variantes calibradas/rank,
aunque combinedUtility sí guarda el valor aplicado. La asignación nuclear con peer
legado desconocido puede bloquear ambos primeros silos sin timeout en el kernel.
Nuestro ledger exige observar un ataque propio antes de atribuir act/target.

Fuentes fijadas: [control de candidatos](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/userscript/20-military-and-planning.js#L179),
[ramas/control](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/userscript/40-economy-runner.js#L2370),
[Learn](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/userscript/00-bootstrap.js#L776),
[gate antiguo](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/trainer/evaluation-v2.cjs#L48),
[gate estricto](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/trainer/promotion-gate-v5.cjs#L13),
[recovery/reservas/peer](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/runtime/decision-kernels.cjs#L18),
[revalidación económica](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/userscript/40-economy-runner.js#L487),
[ETA/riesgo naval](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/userscript/40-economy-runner.js#L1997),
[joint plan](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/userscript/20-military-and-planning.js#L447),
[spawn](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/userscript/10-duo-and-diagnostics.js#L437),
[proxy de confirmación](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/userscript/00-bootstrap.js#L476),
[manifest](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/trainer/candidate-v5-v2-manifest.json#L9).

## OpenFront Intel: escenarios útiles, mecánicas verificadas por componente

La calculadora usa BigInt, coste incremental MIRV, slots disponibles `level-used`
y rango `150-480/(level+5)`: nivel 3 da correctamente 90. `sam-launchers.mdx`
también da ese rango y slots por nivel. Corregimos la advertencia genérica anterior:
el error no es que todo Intel calcule mal el rango. `sam-targeting-priority` incluye
urgencia en su fórmula, pero simplifica a una intercepción por 90 ticks y afirma que
71 tiles extra siempre hacen perder al Hydrogen. El scoring oficial admite el
contraejemplo Atom distance30/time100=170.000 frente a Hydrogen distance101/time1=
178.901. El probe ejecuta el cuerpo oficial; no demuestra reachability de ambos
misiles en una escena física. `nuke-barrage-vs-sam-wall` también mezcla slots con
one-shot y usa 20 ticks/s frente al comentario oficial de 100 ms/tick.

La procedencia del sitio mezcla versiones por guía y un SHA metadata. La regex de
`extractFromConfig` cruza casos y devuelve cero para Atom/Hydrogen/Silo tanto en
su upstream declarado `4e837520e886b255b1b020e9c89639dbb9d54038` como en
v0.34.24 `3f5633b92c9508461e6e2b9e1f926487a1804c9f`. Los payloads de unidades
siguen procediendo de tablas incorporadas; metadata liveConfig no vuelve
correctas esas tablas. No ejecutamos prebuild, que las reescribe.

La guía `coastal-boat-defense` se comprobó contra **su propia v0.34.11**
(`82e5fce9502b99516b5b4b8f06fc0b88823a0cbc`) y, por separado, nuestro motor
`f372cdf9451cd8c3dc113aaaf8641e2609e2d3cb`. En ambos, transport no requiere
Port, tres es un límite concurrente, una ejecución crea un barco, y 20% es un
importe por defecto reemplazable por tropas explícitas. Existe BoatRetreatExecution.
El fixture nativo actual confirma cero Ports, source legal, una orden de 7.000 sobre
20.000 tropas, tres concurrentes/cuarto rechazado y flag de retirada aceptado:
14 aserciones. No se simuló un retorno completo ni se ejecutó el motor viejo.
«Tres barcos de 20% en una orden», «sin puerto no puedes transportar» y «sin recall»
no son reglas trasladables. El pool global de tropas tampoco permite crear una
guarnición local de 6.000 por una orden inexistente en la playa.

Cuatro extracciones, como preguntas/fixtures antes que reglas nuevas:

| Idea y condición                                                                                            | Qué ya tenemos                                           | Delta condicionado y límite                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coste incremental y slots nucleares: comparar siguiente MIRV/serie y cola ocupada antes de planificar salvo | Fixtures de silo/SAM/launch, BigInt y demanda nuclear    | Exponer cálculo explicativo desde Config actual, no constantes web; probar cola parcialmente ocupada y precio que cambia. Delta de slots es teórico, no interceptabilidad.         |
| Saturación SAM por tiempo, nivel y trayectoria cuando hay varias amenazas                                   | Forecast de trayectoria, scheduling y capacidad nativos  | Convertir frases one-shot en contraejemplos oficiales con colas/urgencia/alliances. No añadir otro modelo de cobertura basado sólo en distancia.                                   |
| Intercepción costera antes del arribo: comparar ETA de transporte y tiempo del defensor                     | Planner de intercepción, busy ticks y destino objetivo   | Añadir casos de ruta larga/corta, pérdida de puerto y recall; descartar multiplicador 60% y garrison local ficticia. No copiar HP/velocidad/shell sin pin.                         |
| Economía, spawn y roles por escenario: Port vs Factory, espacio de crecimiento y cooperación bajo amenaza   | StructureBehavior, spawn scoring, diplomacia y Companion | Hacer matriz de condiciones observables y ablations pareadas de deltas concretos. Artículos de team roles/diplomacy no son un controlador ni una prueba de rentabilidad universal. |

Fuentes: [calculadora](https://github.com/redreamality/openfront-intel/blob/50430748acf3fb5f23c033dfa21c3ecbe6251c4f/src/components/NukeCalculator.astro#L312),
[extractor](https://github.com/redreamality/openfront-intel/blob/50430748acf3fb5f23c033dfa21c3ecbe6251c4f/scripts/extract-game-data.mjs#L695),
[SAM correcto](https://github.com/redreamality/openfront-intel/blob/50430748acf3fb5f23c033dfa21c3ecbe6251c4f/src/content/guides/en/sam-launchers.mdx#L33),
[prioridad](https://github.com/redreamality/openfront-intel/blob/50430748acf3fb5f23c033dfa21c3ecbe6251c4f/src/content/guides/en/sam-targeting-priority.mdx#L7),
[clock/barrage](https://github.com/redreamality/openfront-intel/blob/50430748acf3fb5f23c033dfa21c3ecbe6251c4f/src/content/guides/en/nuke-barrage-vs-sam-wall.mdx#L22),
[costera](https://github.com/redreamality/openfront-intel/blob/50430748acf3fb5f23c033dfa21c3ecbe6251c4f/src/content/guides/en/coastal-boat-defense.mdx#L37),
[regla transport v0.34.11](https://github.com/openfrontio/OpenFrontIO/blob/82e5fce9502b99516b5b4b8f06fc0b88823a0cbc/src/core/game/TransportShipUtils.ts#L5),
[importe explícito v0.34.11](https://github.com/openfrontio/OpenFrontIO/blob/82e5fce9502b99516b5b4b8f06fc0b88823a0cbc/src/core/execution/TransportShipExecution.ts#L104),
[recall v0.34.11](https://github.com/openfrontio/OpenFrontIO/blob/82e5fce9502b99516b5b4b8f06fc0b88823a0cbc/src/core/execution/BoatRetreatExecution.ts#L16),
[scoring oficial v0.34.24](https://github.com/openfrontio/OpenFrontIO/blob/3f5633b92c9508461e6e2b9e1f926487a1804c9f/src/core/execution/SAMLauncherExecution.ts#L185).

## Leo: contratos y condiciones reales de ejecución

Main implementa `GameSession`, `NodeMapLoader` y `Predicates` sobre GameRunner real.
La rama avanzada añade especificaciones compartidas TS/JSON/Python, recompensas,
latencia, límites de órdenes y vistas de registros. No incluye el entorno completo,
encoder de observación concreto, decoder de acciones, bridge worker ni entrenador.
No se encontraron pesos ni releases en las ramas inventariadas.

**Extraer:** un contrato versionado entre observación/modelo/acción, límites y FIFO
de latencia para pruebas, y registros de cambios incrementales. La especificación
de 31 acciones es una referencia de diseño, no un modelo ya entrenado. Mantener la
identidad estable del jugador y evitar convertir filtros de candidatos en permisos.

**Descartar:** una segunda copia del motor y el control Nation directo sobre un
Human como prueba de equivalencia con el transporte de órdenes del navegador.
`Predicates` omite parte de diplomacia, inmunidad, fallout y rutas: la revalidación
nativa sigue siendo necesaria.

Fuentes: [sesión real](https://github.com/LeoBaldachino/OpenFrontIOai/blob/e60abae84860341f6070b407240343a57ab117fe/ai/env/GameSession.ts#L188),
[especificación avanzada](https://github.com/LeoBaldachino/OpenFrontIOai/blob/60b10bcfafd78826e5245bc3c79430a881c0984b/ai/spec/spec.ts#L34),
[límites](https://github.com/LeoBaldachino/OpenFrontIOai/blob/60b10bcfafd78826e5245bc3c79430a881c0984b/ai/env/RateLimiter.ts#L1),
[scheduler](https://github.com/LeoBaldachino/OpenFrontIOai/blob/60b10bcfafd78826e5245bc3c79430a881c0984b/ai/env/TurnScheduler.ts#L1).

### Cinco extracciones de Leo

| Algoritmo y condición                                                                                                             | Solapamiento local                                                       | Adaptación condicionada / prueba                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reward por transición: `gammaTick^deltaTicks*Phi(next)-Phi(prev)`; Phi absorbente cero sólo en terminal real                      | Ridge usa land-share al terminar compromiso, con schema de reward propio | Ensayar otro reward offline, con duración variable; no reemplazar su schema en silencio. Telescoping, terminal/truncation y fallout/capacidad nativos. Aux de idle/waste cambia objetivo; no llamarlo PBRS puro.           |
| Contrato semántico versionado: JSON canónico→SHA256, offsets, policy ID, episode/step/tick y FIRST/TERMINATED/TRUNCATED/ENV_ERROR | Import valida features/reward y modelo; evaluator fija procedencia       | Ampliar sólo cuando añadamos features/acciones. No implementar otro decoder de 31 acciones ni truncar rivales a K=8/16. Probar bounds y roundtrip: `RecordView.setBit` sin bounds puede escribir otro tensor, reproducido. |
| Oráculo de rate-limit: token bucket + ventana fija, consumo del segundo token antes del rechazo de minuto                         | Un gate compartido conservador 9/s y 140/min                             | Usarlo en tests offline con mismos timestamps, no elevar límites a 10/150. Tras 150 sends/15s, rechazo deja server/Leo 9 tokens vs Generative 10; reloj cliente no conoce arrivals reales.                                 |
| Latencia por batch y FIFO por seat: una muestra por batch no vacío, clamp al tick anterior, orden cross-seat determinista         | Harness real y ledger ya fijan causalidad/órdenes                        | Perturbación offline, sin randomizar orden live. Probar overtaking, empty batch sin draws, skipped ticks/reset y deadline-spawn; distribución es diseño experimental, no medida de producción.                             |
| Spawn jerárquico: coarse cells, quarter-centres/stride2, full disc nativo y reservas de spawn no ejecutadas                       | Índice/heatmap, scoring y clan/proximidad                                | Reutilizar índice, sin otro full-map scan por frame. Si hay <3 sitios válidos seguir más allá de top20; probar bordes/fallout/reserved overlap/ties. No se ejecutaron sus tests de spawn del motor.                        |

Fuentes avanzadas: [reward](https://github.com/LeoBaldachino/OpenFrontIOai/blob/60b10bcfafd78826e5245bc3c79430a881c0984b/ai/env/Reward.ts#L119),
[hash y flags](https://github.com/LeoBaldachino/OpenFrontIOai/blob/60b10bcfafd78826e5245bc3c79430a881c0984b/ai/spec/spec.ts#L369),
[bounds de RecordView](https://github.com/LeoBaldachino/OpenFrontIOai/blob/60b10bcfafd78826e5245bc3c79430a881c0984b/ai/obs/RecordView.ts#L153),
[rate-limit](https://github.com/LeoBaldachino/OpenFrontIOai/blob/60b10bcfafd78826e5245bc3c79430a881c0984b/ai/env/RateLimiter.ts#L173),
[FIFO](https://github.com/LeoBaldachino/OpenFrontIOai/blob/60b10bcfafd78826e5245bc3c79430a881c0984b/ai/env/TurnScheduler.ts#L72),
[spawn](https://github.com/LeoBaldachino/OpenFrontIOai/blob/60b10bcfafd78826e5245bc3c79430a881c0984b/ai/env/SpawnScorer.ts#L215).

SnapshotPool aporta almacenamiento, no restauración completa: simHash se exige,
specHash es informativo, bytes/meta pueden aliasar al caller y el par checkpoint/
sidecar no es una única transacción. Los probes reproducen alias y mismatch
aceptado; conservar publicación inmutable y validación de schema propias.

## Generative/Apex: arbitraje y evaluación, búsqueda con límites claros

Main registra baseline e idle; la rama avanzada añade Apex, un controlador por
reglas con estado, propuestas y búsqueda opcional. No contiene una política neuronal
entrenada. La búsqueda está apagada por defecto y EndgameController es un stub.

**Extraer:** comparaciones pareadas, conjuntos predeclarados, fingerprints,
presupuesto compartido y contabilidad solo de órdenes enviadas. El evaluador híbrido
congela el bundle/modelo y compara baseline, shadow y learned en las mismas semillas;
mantiene fallos y horizontes truncados fuera de las victorias terminadas.

**Adaptación condicionada:** modelos de ventanas de ataque de Nations, coste de
stacks y arbitraje de propuestas pueden enriquecer características, si su código,
semilla y versión coinciden. No tratar predicciones sobre Humans como hechos.

**Descartar para el userscript actual:** importar `fork()` como si GameView contuviera
estado completo. Requiere réplica del motor, mapa e historial ordenado de turns,
ejecuciones, memoria AI y PRNG. Incluso la réplica carece de acciones humanas futuras.
Los hashes rutinarios parciales no cubren todo el estado; la restauración por bytes
puede divergir tras modificar agua. Su benchmark histórico de búsqueda no prueba
superioridad general ni transferibilidad online.

Fuentes: [Compare](https://github.com/CptFunkymonk/OpenFrontIO-Generative/blob/3de4b47cad875a0a9a5868940d7d7743c421e320/src/agent/arena/Compare.ts#L286),
[Scheduler](https://github.com/CptFunkymonk/OpenFrontIO-Generative/blob/3de4b47cad875a0a9a5868940d7d7743c421e320/src/agent/lib/Scheduler.ts#L378),
[Worker](https://github.com/CptFunkymonk/OpenFrontIO-Generative/blob/7b52b788dfa1f789fbdf7d06bc2c91a6d24cc683/src/agent/browser/AgentWorker.worker.ts#L42),
[clonado](https://github.com/CptFunkymonk/OpenFrontIO-Generative/blob/3de4b47cad875a0a9a5868940d7d7743c421e320/src/core/snapshot/GameClone.ts#L17).

### Cinco extracciones de Generative/Apex

| Algoritmo y condición                                                                                                           | Solapamiento local                                               | Adaptación condicionada / prueba                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rebase de planes demorados: shift relativo por k; eventos absolutos mantienen fecha; invalidar alianza/vida/expiry/ataque       | Guards de generación, await y revalidación final                 | Útil sin fork para probes async de target/build. Usar smallID, no identidad de objeto; probar missed event, reset y cambio de alianza. Slice sólo controla yields: un clone/step caro puede sobrepasarlo.                                       |
| Ventanas de Nation y stack cancellation-aware: answer + (T-answer)/ratio*margin + incomingFromIt; no-answer en W1/W2/W6         | Proyección nativa de coste/defensa y pending commitments         | Primero features/labels sombra de ventanas, no ratios nuevos live. Fijar motor, seed y call-order; probar cancelación opuesta 1:1 y reserve floor. Humans no son Nations deterministas.                                                         |
| Una purse y admisión determinista: reservas por propuesta/class/duplicate key; ledger sólo tras send ok                         | Ledger/reservas y gate de intents existentes                     | No otra cola emisora. Offer-order consume presupuesto antes del sort final: priority no preempta reservas previas. Probar emergency vs low-priority, invalid/rate-limited, pending, ties y aging; send ok no es receipt.                        |
| Gate económico por amenaza: oro sobre reserva, excluir sitio de blast y hold por nuke/reload/invasión                           | StructureBehavior, SAM/silo forecasts, BigInt y reservas pending | Empezar por amenaza visible y reason/expiry, no predicción omnisciente. Probar radios, identidad/alianzas, upgrade en aim, múltiples nukes y dos jugadores. Gold exposure es default; model/allied/free son brazos opcionales.                  |
| Triggers y evaluación explícita: eventos/window/chain/stall, coste presupuestado y degradación declarada; paired sign/bootstrap | Budgets de scans/probes y evaluator pareado/fingerprints/censura | Mejorar scheduling y cohortes, sin framework paralelo. Compare upstream conserva agent errors por defecto y sólo avisa settings mismatch; mantener nuestros gates más estrictos y totals visibles. Recalibrar costes antes de cualquier search. |

A1 strike windows implementadas están activas por defecto; el knob legacy
`strikeWindows` y otros once knobs UNBUILT rechazan valores no default. Endgame
sigue vacío pese al label/default. Los parámetros de NationModel no garantizan
paridad: PseudoRandom coincide, pero nuestro pin añade warships y guards/rutas de
boats, lo que puede alterar decisiones y draws. Matching PRNG no basta.

Fuentes Apex: [rebase](https://github.com/CptFunkymonk/OpenFrontIO-Generative/blob/3de4b47cad875a0a9a5868940d7d7743c421e320/src/agent/lib/search/Slicer.ts#L147),
[ventanas/sizing](https://github.com/CptFunkymonk/OpenFrontIO-Generative/blob/3de4b47cad875a0a9a5868940d7d7743c421e320/src/agent/lib/StrikeWindows.ts#L127),
[admisión](https://github.com/CptFunkymonk/OpenFrontIO-Generative/blob/3de4b47cad875a0a9a5868940d7d7743c421e320/src/agent/lib/Scheduler.ts#L287),
[gold gate](https://github.com/CptFunkymonk/OpenFrontIO-Generative/blob/3de4b47cad875a0a9a5868940d7d7743c421e320/src/agent/lib/GoldPolicy.ts#L170),
[triggers](https://github.com/CptFunkymonk/OpenFrontIO-Generative/blob/3de4b47cad875a0a9a5868940d7d7743c421e320/src/agent/lib/search/Triggers.ts#L172),
[degradación](https://github.com/CptFunkymonk/OpenFrontIO-Generative/blob/3de4b47cad875a0a9a5868940d7d7743c421e320/src/agent/lib/search/Budget.ts#L124),
[UNBUILT](https://github.com/CptFunkymonk/OpenFrontIO-Generative/blob/3de4b47cad875a0a9a5868940d7d7743c421e320/src/agent/agents/apex/options.ts#L2015).

## djmango: estado exacto, memoria, resultados y compatibilidad estricta

Implementa PPO Rust/LibTorch, encoders espaciales y LSTM. **Extraer:** separar hechos
exactos de estado comprimido; normalización fija; registro de acción/resultado;
pruebas de replay/paridad con hashes realmente comprobados; memoria solo cuando
una evaluación pareada demuestre beneficio.

La metadata publicada de V11 sí confirma update 2561/fase 26; la tarjeta que dice
2486/23 está obsoleta. El binario de unos 154 MB fue identificado por metadata, no
descargado ni ejecutado. Gitlink, motor por defecto de paridad y checkpoint tienen
procedencias diferentes. Las dimensiones tampoco coinciden: checkpoint 28 features
de jugador/11 scalars, fuente actual 30/12 y browser fork 12/8. El exportador revisado
acepta schema 1 y crea una política feedforward; el checkpoint V11 es schema 3
recurrente. El comando ONNX del README no es una integración V11 funcional demostrada.

**Descartar:** importar el checkpoint grande sin reconstruir su interfaz y
procedencia; asumir que throughput implica paridad; reciclar semillas de evaluación
usadas para entrenamiento; usar conocimiento del motor no disponible al cliente.
El slot 0 representa territorio neutral: solo 127 jugadores distintos caben sin
alias en esa representación de 128 slots. El límite de 32 unidades también puede
perder información. El sincronizador de Hugging Face admite schemas 1/2 y GRU,
por lo que también rechaza el manifest V11 schema 3/LSTM publicado. El browser
fork sí contiene ONNX anteriores; eso no acredita que pueda ejecutar V11.

Fuentes: [estado exacto](https://github.com/djmango/openfront-ai/blob/474536340480659c53d9a9e497b08fa1fefb9589/rust/ofcore/src/feat.rs#L887),
[memoria](https://github.com/djmango/openfront-ai/blob/474536340480659c53d9a9e497b08fa1fefb9589/rust/oftrain/src/policy.rs#L618),
[checkpoint](https://huggingface.co/djmango/openfront-rl/blob/2e76d885e869e51d6542a30f9b0b0f5a952083e1/ppo_v11/manifest.json),
[loader ONNX](https://github.com/djmango/openfront-ai/blob/474536340480659c53d9a9e497b08fa1fefb9589/webbot_export/safetensors.py#L113).

### Cinco extracciones de djmango

| Algoritmo y condición                                                                                       | Solapamiento local                                                     | Adaptación condicionada / prueba                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hechos/identidades/máscaras exactos; comprimir sólo contexto espacial; cache static por game/episode/schema | gameApi, smallID, guards de amistad/legality y ranking sin slots fijos | No importar AE ni aliasar >127 jugadores o >32 unidades. Probar reorder/eliminación, teammate vs alianza temporal y stale completion. `log_norm` no está limitado a [0,1].                                                             |
| Ledger decisión→receipt→outcome y edad de campaña por target semántico                                      | Hybrid mantiene generación, pending receipt y commitments              | Extender diagnósticos existentes. No copiar quantity-bits como identidad ni emitted-count como éxito estratégico. Probar delayed/absent/resend/terminal/reset; memoria recurrente sólo tras ablation.                                  |
| Potencial con Phi terminal absorbente cero                                                                  | Reward ridge actual mide land-share al fin del compromiso              | Otro schema/model identity y brazo offline, no cambiar en sitio. Probar telescoping, reversión y true terminal vs cap. Reward upstream completo también tiene action/tempo/waste y no es PBRS puro.                                    |
| Benchmark por versión lanzada, componente y cohorte; modelo/normalizador congelados                         | Holdout y fingerprints, errores/horizontes visibles                    | Atribuir eval async al snapshot lanzado, single-flight y namespace reservado. Upstream usa w{i}-ep0 también al iniciar training: no copiar contaminación. Throughput o AE reconstruction no prueban fuerza.                            |
| Worker con arrays transferibles/request IDs si inferencia bloquea UI medida                                 | Timeouts/generación/intent guards existentes                           | Sólo con medición: deadline, rechazar pending al stop, terminate y revalidar antes de emitir. Worker upstream carece de deadline/dispose y PlaySession puede enviar después de await con turns queued. No prueba latencia/browser V11. |

Fuentes: [features exactas](https://github.com/djmango/openfront-ai/blob/474536340480659c53d9a9e497b08fa1fefb9589/rust/ofcore/src/feat.rs#L887),
[cache estático](https://github.com/djmango/openfront-ai/blob/474536340480659c53d9a9e497b08fa1fefb9589/rust/oftrain/src/ae.rs#L335),
[receipt/outcome](https://github.com/djmango/openfront-ai/blob/474536340480659c53d9a9e497b08fa1fefb9589/rust/oftrain/src/vecenv.rs#L2022),
[potencial terminal](https://github.com/djmango/openfront-ai/blob/474536340480659c53d9a9e497b08fa1fefb9589/rust/oftrain/src/vecenv.rs#L2126),
[eval](https://github.com/djmango/openfront-ai/blob/474536340480659c53d9a9e497b08fa1fefb9589/rust/oftrain/src/train.rs#L3887),
[Worker](https://github.com/djmango/OpenFrontIO/blob/79834ec159685761e2348d3a707408ea5c3c28c2/src/client/webbot/workerModels.ts#L85),
[send tras await](https://github.com/djmango/OpenFrontIO/blob/79834ec159685761e2348d3a707408ea5c3c28c2/src/client/webbot/PlaySession.ts#L194).

Los tests del sincronizador cubren schemas viejos; la función real rechaza V11
schema3/LSTM. El browser viejo alimenta un static AE input que el export actual ya
no acepta. Los reportes after-fix conservan divergencias en ticks 1.750 y 2.050:
no son reruns del engine actual ni paridad verde.

## OpenFrontMind: gate independiente e identidad de objetivos

**Extraer:** esperar/actuar separado del ranking de entidades; proporción de tropas
respecto a capacidad, hostilidad y compromisos; baseline paciente contra el mismo
escenario; estadísticas de normalización congeladas durante inferencia.

El código actual no coincide con todos los hitos del README: tiene unos 2,25M
parámetros, no los 414K históricos. Su autoimitación usa `AnchorBuffer` con ventajas
positivas y un umbral de tropas, no exclusivamente episodios ganadores. La configuración
actual utiliza Nations Easy por reglas; no se verificó una liga de oponentes aprendidos.
El motor requerido está ignorado, sin SHA público fijado, y no hay pesos incluidos
en el árbol auditado ni un runtime/exportador para el navegador. Esto no demuestra
que no exista algún checkpoint fuera de ese árbol.

**Errores que evitamos en la adaptación:** con 16 candidatos, su truncado elimina
el sentinel de esperar y puede convertirlo en ataque al primer objetivo. Además,
la likelihood PPO calculada deja de coincidir con la probabilidad ejecutada.
Los ataques existentes siguen representados como contexto, pero quedan excluidos
de la máscara de selección de objetivos; trata el límite de ticks como derrota;
su shaping terminal omite la corrección del potencial absorbente. La política local
tiene esperar fuera de la lista, no limita slots de rivales, conserva refuerzos y
no convierte partidas truncadas en derrotas.

Fuentes: [gate](https://github.com/x3rdev/openfrontmind/blob/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3/training/models/policy.py#L119),
[truncado](https://github.com/x3rdev/openfrontmind/blob/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3/training/envs/action_space.py#L74),
[AnchorBuffer](https://github.com/x3rdev/openfrontmind/blob/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3/training/models/anchor_buffer.py#L79),
[recompensa](https://github.com/x3rdev/openfrontmind/blob/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3/training/envs/reward.py#L44).

### Cinco extracciones de OpenFrontMind

| Algoritmo y condición                                                             | Solapamiento local                                                 | Adaptación condicionada / prueba                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate WAIT/ACT y target rank condicional; WAIT fuera de candidatos truncables      | Hybrid ya separa wait/act/target sin sentinel ni límite16          | Preservar reinforcements por decisión explícita; probar 0/15/16/17, reorder y active first row. Separación evita dilución estructural, no toda dependencia contextual del número de rivales.                                                                   |
| Ratios de capacidad/reserva, incoming/outgoing propios y hostilidad por candidato | Features ridge y reservas/compromisos nativos                      | Añadir geometría específica de target sólo tras contraste: filas idénticas dan scores idénticos aunque mapa difiera. No aprender ordinal smallID ni copiar .422/20% sin Config actual.                                                                         |
| Normalizador versionado y congelado con pesos                                     | Import/export ya versiona features/reward y holdout congela modelo | Si se añaden running moments, entrenar/guardar juntos y replays raw/versionados. Probar cambios de unidades/schema y PBT: anchors normalizados antiguos no deben mezclarse con stats nuevas.                                                                   |
| Baseline paciente pareado y diagnóstico por reserve/candidate buckets             | Comparación baseline/shadow/learned en harness real                | Analizar P(wait), reservas y ranking por cohorte sin threshold universal. Corregir capped denominators y usar mismas semillas en sweeps; tooling diagnóstico no es promoción.                                                                                  |
| Biblioteca pequeña de estados pacientes raros, sólo con etiquetas fiables         | Outcome ledger y colección exportable existentes                   | Hipótesis posterior, offline/opt-in: admitir positivos con normalizer/model/engine tags, reset incompatibles y ablation. Source admite ratio≥.35 + ventaja positiva; eso no significa episodio ganador ni causalidad. No importar replay espacial main-thread. |

Fuentes: [gate y pointer](https://github.com/x3rdev/openfrontmind/blob/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3/training/models/policy.py#L119),
[ratios](https://github.com/x3rdev/openfrontmind/blob/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3/training/envs/observation.py#L114),
[normalizador](https://github.com/x3rdev/openfrontmind/blob/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3/training/envs/running_stats.py#L14),
[baseline](https://github.com/x3rdev/openfrontmind/blob/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3/training/models/patience_heuristic.py#L16),
[anchors](https://github.com/x3rdev/openfrontmind/blob/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3/training/models/anchor_buffer.py#L79).

Más límites reproducidos: compresión de ratios float16 es lossy; .422 pasa a
.422119140625. `watch` convierte winner=None por truncación en won=False; no sirve
como estimador de winrate sólo de partidas completas. El loader elimina parámetros
con shapes distintos y carga strict=False, lo que permite capas aleatorias sin un
contrato íntegro. PBT de learners y EMA de training no equivalen a liga de oponentes
aprendidos ni holdout. La cifra exacta actual de parámetros es 2.251.133; no prueba
viabilidad/latencia en userscript.

## Arquitectura común y orden de extracción

Un único flujo emisor conserva el presupuesto de intents, las reservas, la
identidad y las comprobaciones de generación/async del bot actual. Un módulo
opcional propone esperar o puntuar candidatos; el ejecutor existente revalida y
emite, el ledger observa el recibo y después el efecto. Ni modelo, relay, Worker ni
fork reciben permiso por una etiqueta de candidato. No añadir un segundo bot,
ledger independiente o cola de órdenes que salte ese arbitraje.

1. **Etiquetas e integridad de evaluación primero:** intención != receipt != efecto;
   terminal real != horizonte; snapshot congelado, semillas/config efectivas,
   procedencia, cohorts/exclusiones y errores explícitos. Congelar antes de comparar.
2. **Contratos de features después:** unidades, geometría por target, identidad,
   normalización y reward versionados; datos faltantes no son cero. Rechazar
   snapshots incompatibles/fríos para holdout. Readiness de conteos no certifica
   calidad ni mejora.
3. **Macro/micro como experimentos posteriores:** ventanas Nation, prioridad
   económica, decisiones navales/duo/spawn y memoria/Workers sólo si aparece un
   déficit medido. Un cambio por brazo, guards actuales y test nativo antes de
   holdout. Search/fork requiere motor/turns/PRNG/memoria completos, no GameView.

Esta continuación aborda cuatro defectos de integridad locales, no una ampliación
neural: flush de compromiso pendiente al terminal; actualización numérica fail-closed
(incluida covarianza candidata finita pero singular por cancelación, también posible
en HEAD anterior); detección de colisiones de semilla efectiva/hash; y nombre honesto
`candidateDecisionPairs`. Este último cuenta decisiones propuestas en shadow/learned,
no ataques aceptados ni control aprendido ejercido. Las cuatro correcciones están
implementadas y sus regresiones focales de runtime/evaluador pasan. Las revisiones
independientes acotadas comprobaron el incremento de covarianza y las colisiones de
semilla. Esta evidencia corresponde al snapshot propio validado; no demuestra
fuerza de juego ni sustituye el recibo de publicación y sus controles.

No hay promoción automática, checkpoint externo integrado ni comparación válida
terminada que pruebe mejora de fuerza. La arquitectura se juzga por contratos y
mediciones acotadas; la fuerza se juzgaría por holdout pareado de victorias completas.

## Integración realizada y límites

Implementación propia: `hybridCombat.js`, hooks en el flujo real de ataques/ticks,
controles y export/import, seis idiomas, y evaluador pareado con el harness real.
La regresión contextual online no es una red neuronal ni una reproducción de PPO.
No se han copiado pesos, assets, encoders, entrenadores ni bloques de fuente de los
proyectos. Se conservaron Legendary y sus guards como base; se reimplementaron ideas
arquitectónicas acotadas. Observar es el modo inicial; controlar es experimental.

No se encontraron LICENSE/COPYING/NOTICE propios en AggroBot, Intel, djmango ni
OpenFrontMind. La tarjeta de pesos de djmango declara MIT, lo que no establece la
licencia de todo su código. Leo/Generative sí incluyen AGPLv3 y términos adicionales;
assets tienen condiciones distintas. Esta entrega no es un paquete redistribuido
de esas fuentes.

El criterio de aceptación para controlar el bot es mejora en victorias terminadas
con semillas reservadas, sin romper legalidad/reservas, con modelo congelado,
provenance, fallos visibles y presupuesto/latencia medidos. Un checkpoint con muestras
o un test verde de plumbing no demuestra esa mejora. Esta auditoría no prueba fuerza
online frente a humanos ni compatibilidad de los modelos externos.

## Evidencia acotada de la auditoría profunda

Las ramas principales remotas siguen en los SHA de la tabla. Aggro/Intel son
archives sin `.git`: se cotejaron todos sus 193 y 1.140 blobs upstream contra los
árboles públicos fijados, sin discrepancias. Leo/Generative y djmango/Mind se
revalidaron por los equipos de revisión; refs secundarias inventariadas no implican lectura
semántica completa de cada rama. No se descargaron checkpoints ni se ejecutaron
servicios de training, partidas largas o bots live.

| Proyecto                   | Ejecución realmente realizada                                                                                                                                     | Límites/fallos explícitos                                                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AggroBot                   | 25 scripts oficiales: 24 exit0, 1 exit1. Strategy: 325 checks/0 fallos; policies/features/labels/holdout/receipts y Run3 read-only check                          | Deployment-identity falla en string alemán `Deployment: Modell` mientras UI usa inglés `Deployment: model`; no inferir hash defectuoso. GameView mocks, sin medir victorias. Manifest departure cita tres artifacts ausentes. |
| Intel                      | Node search-console 2/2 tests; core audit 95/95 páginas; whats-new 12 entries/815 archivos                                                                        | Audits prueban formato/metadata, no mecánica. 25 archivos E2E inventariados, no ejecutados. Extractor writer/prebuild no ejecutado.                                                                                           |
| Aggro/Intel probes propios | 11 aserciones de counters/gate/peer/regex + 4 de scoring SAM oficial + 14 de transport nativo = 29                                                                | Scoring aislado no simula reachability; native transport prueba flag recall, no llegada de vuelta. Engine actual f372, fuente vieja por SHA separada.                                                                         |
| Leo / Generative-Apex      | 90 tests originales: Leo scheduler/pool14 + reward7 + rate9; Apex windows/triggers42 + scheduler18. Cinco grupos de probes de spec/bounds/rate/rebase/alias pasan | Options no colectó por recurso QuickChat ausente en sparse clone; no llamarlo verde. Sin tests engine spawn, fork parity, Compare/budget completos ni gameplay.                                                               |
| djmango                    | Tres probes Rust std-only de fuente exacta; dos rechazos del loader real por AST; un rechazo del sync con metadata V11 real; cinco tests oficiales FakeApi pasan  | Sin LibTorch/forward/weights ni rerun de paridad. Primer linker falló y se corrigió sólo en scratch; los cinco tests viejos no acreditan V11.                                                                                 |
| OpenFrontMind              | Nueve probes pasan: sentinel/likelihood, active-target, identidad, reward terminal, float16 y timeout                                                             | AST con sustituto mínimo de construcción NumPy y counterparts escalares; no PyTorch, motor ignorado, checkpoint ni browser.                                                                                                   |

Artefactos de las revisiones (rutas temporales locales, no dependencias del producto):

- Aggro/Intel: `/tmp/ofh-aggro-intel-audit-0usg6wdq/audit-aggro-intel.md`,
  inventarios completos `*-inventory.json`, `official-test-results.json`,
  `counterexamples.cjs`, `sam-priority-probe.cjs`, `coastal-native-fixture.mts`.
- djmango/OpenFrontMind: `/tmp/ofh-deep-two-projects-20261011/audit-index.md`,
  `djmango-audit.md`, `proof/verify.py`, `proof/checkpoint-sync-tests.txt`,
  `openfrontmind-audit-owned/audit.md` y `checks.py`.
- Leo/Generative-Apex: `/tmp/ofh-leo-generative-deep-20261011/report.md`,
  `inventory.json`, logs `*-tests.log`, `pure-checks.mjs` y `pure-checks.log`.

Los resultados de los equipos de revisión se tomaron de sus informes/logs fijados;
no se realizó una segunda ejecución de esas pruebas. Cantidades de comandos, tests y grupos de probes
son unidades distintas y no se suman como un único total. Las propuestas por cada
proyecto son hipótesis de extracción propia; sólo se integró el módulo local y las
correcciones de integridad indicadas, no las 29 ideas ni redes externas.

## Validación histórica local de la primera entrega

Las pruebas de regresión cubren identidad de candidatos, esperar con más de 16
rivales, covarianza finita/simétrica/positiva, importación atómica, modelos congelados,
confirmación de ataques nuevos, refuerzos ambiguos y cambios de generación durante
operaciones asíncronas. Dos revisiones independientes encontraron siete defectos de
la primera versión; quedaron corregidos y la revisión focal final no encontró otro
problema accionable. Esto es evidencia acotada de corrección, no de fuerza de juego.

En la primera validación pasaron learner/evaluador, TypeScript, smoke, paridad del build,
contabilidad de intenciones, defensa entrante y desgaste de contraataques. Los cuatro
archivos nuevos de código/pruebas no tienen diagnósticos ESLint. Se detectaron entonces
diagnósticos previos de complejidad; el commit posterior descrito abajo los resolvió
en los métodos incluidos en su alcance. No extrapolar ese resultado a fuentes futuras.

El contrato de constantes requirió añadir las tres constantes híbridas y actualizar
el registro de traducciones; era una omisión de esta integración, ya corregida sin
alterar las otras entradas concurrentes. La prueba Legendary del checkout combinado
falló entonces en el fixture de saturación de fábricas, con cambios concurrentes.
`check:i18n` devolvió error por
10 claves previas de Commerce raid/Raid fleet; las 12 nuevas están en los seis idiomas.

Una ejecución del build corregido con motor real, Labyrinth Compact, cuatro Nations,
seis tribes y 2.200 ticks produjo 15 decisiones y 15 muestras de espera, sin errores
del learner ni rechazos del presupuesto de intents. Terminó por límite de ticks:
no cuenta como derrota ni victoria. No produjo muestras de atacar/objetivo, por lo
que el modelo sigue frío y no es candidato a controlar partidas.
La repetición en baseline con la misma semilla produjo los mismos cuatro snapshots
de progreso (excluyendo tiempo de pared), estado final, 129 intents emitidos y
presupuesto de intents. Es una comprobación acotada de que observar conserva el
comportamiento; no demuestra equivalencia en todos los escenarios.
Semilla: `ofh-random-team-1791680185022`; motor:
`f372cdf9451cd8c3dc113aaaf8641e2609e2d3cb`. Logs locales:
`/tmp/ofh-hybrid-final-runtime-20261011.jsonl` y
`/tmp/ofh-hybrid-final-baseline-20261011.jsonl`.

Las tres recolecciones anteriores de 8.000 ticks agotaron su timeout y quedaron
excluidas. Además precedían a las correcciones, por lo que no se usarán para promoción.
No hay una comparación terminada y válida que demuestre mejora del modo aprendido.

## Estado de integración y publicación

Los cambios y los bundles están en el checkout local; no se publicaron ni se hizo
push. Se preparó y validó también un snapshot de HEAD más únicamente los cambios
propios, con bundles regenerados, paridad y smoke correctos, para evitar incorporar
el trabajo concurrente. El primer intento de commit detectó que `engine:update`
heredaba el índice alternativo del padre y mostraba falsamente cambios en el motor.
La corrección conserva el entorno Git del padre y elimina sus variables locales
solo en consultas al motor, también en las pruebas y fingerprints de evaluación.
El pre-commit ahora comprueba limpieza y coincidencia con la revisión staged, sin
fetch, checkout ni staging automático. La actualización sigue siendo explícita con
`npm run engine:update`. Una prueba aislada reproduce el fallo original y verifica
que los cambios reales y las revisiones incorrectas siguen bloqueando el commit.
No se desactivan hooks ni se incluyen los blobs ajenos que ya estaban staged.
El commit `d50eeeab442b4541d47f2550c8edb810e7ae2cd7` completó el hook normal,
los controles globales y la suite lógica. Su árbol fue comparado con el candidato
validado. El índice se reconcilió después para conservar exactamente los nueve
paths preparados por otros, sin incorporar sus cambios sin stage; los bundles de
esa selección se reconstruyeron desde sus fuentes. No se hizo push.

La comprobación global también detectó problemas ya presentes en HEAD. Con la
ampliación de alcance autorizada se refactorizaron las ramas complejas de
`nukeBehavior.js`, `structureBehavior.js` y `context.js`, preservando orden de llamadas,
condiciones y cambios concurrentes. Los controles y sus umbrales siguen activos.
El smoke de navegador conserva su implementación y declara la dependencia
`playwright-core` que ya utilizaba. Las fixtures repetidas comparten preparación
del motor, conservando sus escenarios y aserciones.
