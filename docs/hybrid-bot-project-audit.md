# Auditoría y extracción para el bot híbrido

Fecha: 2026-10-11. Alcance: seis repositorios compartidos, ramas principales y
ramas avanzadas relevantes. Se inspeccionaron árboles completos, implementaciones,
esquemas de observación/acciones, modelos, integración, pruebas y licencias.
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

## AggroBot: ejecución, coordinación y evidencia

**Extraer:** separación entre intención, confirmación y efecto; comprobaciones
después de operaciones asíncronas; explicación de reservas; observación de modelos
antes de permitirles controlar órdenes. El módulo híbrido reutiliza nuestro ledger
y exige ver un ataque propio antes de atribuirle un resultado. La coordinación se
deriva de compromisos visibles y pendientes, sin añadir otro relay o ledger.

Referencias: [recibos de acciones](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/runtime/decision-kernels.cjs#L111),
[revalidación de construcción](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/userscript/40-economy-runner.js#L487),
[reservas](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/userscript/20-military-and-planning.js#L1175).

Run3 contiene un checkpoint real Schema 4, `24x24x16-tanh`, con 1.000 pesos.
Sus salidas modifican planificadores; no son acciones ejecutables. “Learn” ajusta
agresividad/reserva mediante un proxy de progreso, sin actualizar esos pesos.
La promoción activa acepta ciertos avances de supervivencia/territorio sin mejorar
victorias: “champion” no equivale a mayor tasa de victoria.

**Descartar como trasplante directo:** sus pesos y umbrales sin reproducir las 24
observaciones/16 salidas; autostart; modelos sombra sin parámetros; coordinación
nuclear que pueda esperar indefinidamente por un compañero sin presupuesto.
Una prueba de su asignación reproduce espera persistente con un peer legado de
preparación desconocida. Su esquema candidato 5 declara `liveDeployment:false`.

Fuentes: [Run3](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/tools/build-run3-bundle.cjs#L18),
[Learn](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/userscript/00-bootstrap.js#L756),
[promoción](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/trainer/evaluation-v2.cjs#L48),
[asignación nuclear](https://github.com/SLP-DEV1/openfront-bot/blob/62e1e78fa2a4f29adb04284c852f8eef96dcce15/src/runtime/decision-kernels.cjs#L134).

## OpenFront Intel: hipótesis y calculadoras, no autoridad del motor

**Extraer:** preguntas concretas sobre coste incremental, slots nucleares,
cobertura/intercepción SAM y efectos de los niveles. Reconstruir sus pruebas con
Config y ejecuciones oficiales; conservar BigInt para el oro.

La procedencia mezcla un SHA upstream y versiones distintas. El extractor produce
principalmente tablas incorporadas; su regex cruza casos del switch y devolvió cero
para AtomBomb, HydrogenBomb y MissileSilo contra su upstream declarado. La guía SAM
también confunde rango y capacidad: el motor auditado usa rango 90 en nivel 3, y los
slots ocupados/nivel condicionan la capacidad. Su atajo de prioridad por distancia
ignora urgencia; hay contraejemplos calculables con la función oficial.

**Descartar:** constantes de la web, etiquetas “verified” y resultados del extractor
como sustitutos de los contratos actuales del motor. Nuestro proyecto ya contiene
fixtures de capacidad, trayectorias, explosión y lanzamiento; no duplicarlos.

Fuentes: [calculadora](https://github.com/redreamality/openfront-intel/blob/50430748acf3fb5f23c033dfa21c3ecbe6251c4f/src/components/NukeCalculator.astro#L282),
[extractor](https://github.com/redreamality/openfront-intel/blob/50430748acf3fb5f23c033dfa21c3ecbe6251c4f/scripts/extract-game-data.mjs#L695),
[guía](https://github.com/redreamality/openfront-intel/blob/50430748acf3fb5f23c033dfa21c3ecbe6251c4f/src/content/guides/en/sam-targeting-priority.mdx#L20),
[ejecución oficial auditada](https://github.com/openfrontio/OpenFrontIO/blob/3f5633b92c9508461e6e2b9e1f926487a1804c9f/src/core/execution/SAMLauncherExecution.ts#L185).

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
Los límites de 128 jugadores/32 unidades pueden perder identidad/información.

Fuentes: [estado exacto](https://github.com/djmango/openfront-ai/blob/474536340480659c53d9a9e497b08fa1fefb9589/rust/ofcore/src/feat.rs#L887),
[memoria](https://github.com/djmango/openfront-ai/blob/474536340480659c53d9a9e497b08fa1fefb9589/rust/oftrain/src/policy.rs#L618),
[checkpoint](https://huggingface.co/djmango/openfront-rl/blob/2e76d885e869e51d6542a30f9b0b0f5a952083e1/ppo_v11/manifest.json),
[loader ONNX](https://github.com/djmango/openfront-ai/blob/474536340480659c53d9a9e497b08fa1fefb9589/webbot_export/safetensors.py#L113).

## OpenFrontMind: gate independiente e identidad de objetivos

**Extraer:** esperar/actuar separado del ranking de entidades; proporción de tropas
respecto a capacidad, hostilidad y compromisos; baseline paciente contra el mismo
escenario; estadísticas de normalización congeladas durante inferencia.

El código actual no coincide con todos los hitos del README: tiene unos 2,25M
parámetros, no los 414K históricos. Su autoimitación usa `AnchorBuffer` con ventajas
positivas y un umbral de tropas, no exclusivamente episodios ganadores. La configuración
actual utiliza Nations Easy por reglas; no se verificó una liga de oponentes aprendidos.
El motor requerido está ignorado, sin SHA público fijado, y no hay pesos publicados.

**Errores que evitamos en la adaptación:** con 16 candidatos, su truncado elimina
el sentinel de esperar y puede convertirlo en ataque al primer objetivo; los ataques
existentes quedan excluidos del ranking; trata el límite de ticks como derrota;
su shaping terminal omite la corrección del potencial absorbente. La política local
tiene esperar fuera de la lista, no limita slots de rivales, conserva refuerzos y
no convierte partidas truncadas en derrotas.

Fuentes: [gate](https://github.com/x3rdev/openfrontmind/blob/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3/training/models/policy.py#L119),
[truncado](https://github.com/x3rdev/openfrontmind/blob/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3/training/envs/action_space.py#L74),
[AnchorBuffer](https://github.com/x3rdev/openfrontmind/blob/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3/training/models/anchor_buffer.py#L79),
[recompensa](https://github.com/x3rdev/openfrontmind/blob/fcbf444c3de3c6f247b56d90a4d743c04fe2c4e3/training/envs/reward.py#L44).

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

## Validación local de esta entrega

Las pruebas de regresión cubren identidad de candidatos, esperar con más de 16
rivales, covarianza finita/simétrica/positiva, importación atómica, modelos congelados,
confirmación de ataques nuevos, refuerzos ambiguos y cambios de generación durante
operaciones asíncronas. Dos revisiones independientes encontraron siete defectos de
la primera versión; quedaron corregidos y la revisión focal final no encontró otro
problema accionable. Esto es evidencia acotada de corrección, no de fuerza de juego.

Pasan las pruebas del learner/evaluador, TypeScript, smoke, paridad del build,
contabilidad de intenciones, defensa entrante y desgaste de contraataques. Los cuatro
archivos nuevos de código/pruebas no tienen diagnósticos ESLint. Se mantienen los
diagnósticos previos de complejidad en métodos existentes del bot.

El contrato de constantes requirió añadir las tres constantes híbridas y actualizar
el registro de traducciones; era una omisión de esta integración, ya corregida sin
alterar las otras entradas concurrentes. La prueba Legendary del checkout combinado
falla en el fixture de saturación de fábricas, con cambios concurrentes.
`check:i18n` devuelve error por
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
La comprobación global también detectó problemas ya presentes en HEAD. Con la
ampliación de alcance autorizada se refactorizaron las ramas complejas de
`nukeBehavior.js`, `structureBehavior.js` y `context.js`, preservando orden de llamadas,
condiciones y cambios concurrentes. Los controles y sus umbrales siguen activos.
El smoke de navegador conserva su implementación y declara la dependencia
`playwright-core` que ya utilizaba. Las fixtures repetidas comparten preparación
del motor, conservando sus escenarios y aserciones.
