# Aprendizaje del bot híbrido

Legendary conserva la ejecución y los controles nativos. Los modelos adicionales
predicen utilidades de esperar, atacar y elegir un objetivo. No son una política
PPO: sus decisiones son deterministas y el registro declara probabilidades y
log-probabilidades desconocidas. No se calcula entropía a partir de utilidades.

## Contratos separados

| Capacidad                | Entrada y límite                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modelo compacto anterior | `ofh-combat-compact-tanh-v2`; conserva sus pesos y 13 características de objetivo.                                                                                                                       |
| Modelo de frontera       | `ofh-combat-compact-tanh-v3`; 17 características de objetivo, incluyendo frontera compartida y presión procedente del objetivo, con indicadores de presencia. No migra automáticamente pesos anteriores. |
| Observación de ventanas  | Dos observaciones nativas de tropas y compromisos por enemigo. Una desaparición no demuestra retirada; datos ausentes siguen desconocidos.                                                               |
| Aprendizaje táctico      | Recompensa de cambio de fracción de territorio durante un compromiso confirmado. Es una señal contextual, no atribución causal de una victoria.                                                          |
| Retorno terminal         | Ajuste offline con vencedor y tick final nativos, descuento temporal explícito y acciones controladas enlazadas. Los límites de ticks y errores se excluyen, no se etiquetan como derrotas.              |
| Evaluación               | Mismos modelos congelados, configuraciones y semillas emparejadas; entrenamiento y holdout disjuntos también por semilla efectiva del motor.                                                             |

Las características ausentes no se sustituyen por evidencia de ausencia de amenaza.
Una presión conocida de cero y una presión desconocida tienen representaciones
distintas. Los perfiles de características, normalizadores y recompensas se validan
en importación y replay; un perfil incompatible se rechaza.

El selector del panel prepara un borrador. **Importar** es la activación explícita.
Los modelos con recompensa terminal o PBRS offline no pueden aprender las etiquetas
tácticas en vivo. Ningún entrenador activa o promociona modelos automáticamente.

## Colección acotada y holdout

`scripts/headless/train-hybrid-combat.mjs` declara antes de empezar las semillas,
cohortes, configuración y requisitos de aceptación. Reanuda el checkpoint exportado
por cada lote y comprueba su hash y compatibilidad con las fuentes actuales. Detiene
la colección cuando la API nativa indica cobertura suficiente o se agotan las
semillas declaradas. Solo un modelo listo pasa al holdout congelado.

`--collection-stop seed-bound` completa todas las semillas de entrenamiento
declaradas aunque el modelo ya esté listo; el valor predeterminado, `readiness`,
conserva la parada al alcanzar cobertura mínima. El criterio se registra antes
del lanzamiento. No modifica los requisitos de readiness ni permite evaluar un
modelo frío. Úsalo para separar cobertura mínima de un presupuesto de entrenamiento
predefinido, sin elegir la parada según victorias del holdout.

La opción experimental `--control-profile target-value-v1` solo admite
`compact-neural`. Compara el valor del mejor objetivo financiado con WAIT y evita
reintentar objetivos cuyo valor no supere WAIT. El perfil queda ligado al modelo
y al hash de características; omitirlo conserva el control anterior por la
cabeza ACT. No cambia recompensas, aprendizaje ni comprobaciones de seguridad.
Debe entrenarse y evaluarse como un brazo independiente; no demuestra una mejora.

`--control-profile tribe-ranking-v1` exige además `--feature-profile frontier-v1`.
Conserva esa comparación estratégica y añade una selección de la primera tribu
entre los candidatos terrestres financiados del plan nativo, después del filtro
de clúster y antes de cualquier barco. Nunca sustituye por WAIT el ataque a tribus.
El resto del lote mantiene su orden; reservas, legalidad y límites de envío siguen
en el emisor original. Requiere un modelo nuevo y entrenamiento independiente:
no se puede cambiar la etiqueta de un checkpoint anterior. Los fallos o datos
obsoletos de geometría conservan el orden nativo. La latencia de esta ruta se
registra como `tribe-choice`, incluida la preparación y el envío seleccionado.

El perfil experimental de headless `tribe-only-terminal-v1` utiliza esa misma
selección financiada, pero deja los ataques estratégicos y WAIT a Legendary.
Solo TARGET decide; ACT y WAIT son auxiliares o inactivos. Mantiene todos los
requisitos de preparación anteriores y exige un modelo nuevo. Su ajuste terminal
usa `gammaTick=1`, recibos propios y el ganador nativo real; los ejemplos tácticos
del arranque no se presentan como ejemplos terminales. No activa ningún modelo.

Ejemplo de invocación, con valores elegidos para el experimento y archivos de
cohortes/requisitos preparados previamente:

```sh
node scripts/headless/train-hybrid-combat.mjs \
  --policy compact-neural --feature-profile frontier-v1 \
  --training-seeds train-a,train-b,train-c,train-d \
  --holdout-seeds holdout-a,holdout-b \
  --batch-size 2 --timeout-ms 900000 \
  --cohorts /tmp/cohorts.json --requirements /tmp/requirements.json \
  --out /tmp/hybrid-training
```

El timeout y el tamaño del lote son parámetros operativos del ejemplo, no umbrales
de calidad. El entorno `OFH_*` y `GAME_ENV` determina el mapa y las reglas; se
registra en el plan. Cada ejecución usa una cohorte de configuración; cambiar de
mapa o reglas requiere otra ejecución y procedencia explícita, no reescribir la
procedencia de un checkpoint. Un checkpoint anterior solo se reanuda con sus
fuentes y configuración compatibles.

`plan.json`, los recibos de cada lote y `result.json` se publican atómicamente.
Las salidas distinguen un runner oficial de una fixture inyectada. `ready` permite
probar inferencia; no certifica fuerza ni concede promoción.

## Registros y aprendizaje offline

La colección y evaluación conservan registros incrementales completos cuando el
productor nativo verifica identidad y cierre. La exportación separa propuestas,
decisiones controladas, aceptación, recibo y resultado. Una cola retenida con
eventos descartados no se convierte en una trayectoria completa.

La lectura incremental limita cada línea y el contenido codificado único a
256 MiB. Comparte internamente cadenas `modelIdentity` exactamente iguales, sin
cambiar sus valores, y contrasta el número de filas con los recuentos nativos.
Así admite historiales físicos mayores sin eliminar eventos ni quitar límites
de memoria. Los informes se escriben por bloques y se publican de forma atómica
y exclusiva; la CLI devuelve un resumen y la ruta del informe.
Las decisiones observadas conservan su
numeración original. Solo se ajustan acciones controladas con enlaces verificados;
las decisiones excluidas deben tener un motivo comprobado y cubrir explícitamente
los huecos, sin convertir fallbacks en esperas aprendidas.

`scripts/headless/train-hybrid-returns.mjs` requiere un ledger completo, selección
explícita de la identidad original del modelo, snapshot original y resultado nativo
congelado. Ajusta un grupo verificado; no fusiona episodios de distintas partidas
por tener el mismo número. El descuento por tick es obligatorio. La salida incluye
el modelo y su procedencia nueva; el holdout futuro sigue pendiente y bloquea la
promoción. Solicitar entrenamiento estocástico con probabilidades desconocidas
debe fallar.

La salida también incluye `trained-model.json`, un sobre nuevo que puede importar
el evaluador estricto. Conserva las huellas reales del run de origen, recalcula
las del modelo ajustado y su recompensa, e incluye la procedencia del ajuste.
No modifica el manifiesto original ni habilita aprendizaje táctico en vivo.
El evaluador rechazará el sobre si las fuentes, el harness o la configuración
actuales ya no coinciden; en ese caso hace falta nueva evidencia compatible.

El historial incremental compara el contenido de las filas de seguridad tras
quitar únicamente el discriminador de transporte `kind`. Sigue comprobando
contenido, identidad, recuentos, retención y cierre; no acepta un historial
incompleto solo porque la partida haya terminado correctamente.

El resultado debe acreditar ejecución completada, procedencia positiva y revisión
y diff del motor coincidentes al inicio. Una derrota terminal válida puede aportar
retorno negativo; un error, una interrupción o una infracción del presupuesto no
se convierte en una derrota de entrenamiento.

Los nuevos ajustes exportan `offline-terminal-return-v2`: guardan una única copia
estructurada y exacta del modelo de origen. La identidad original sigue siendo
obligatoria durante el ajuste; puede reconstruirse con `JSON.stringify(originModel)`.
Se validan recursivamente el contrato y los incrementos reales de muestras. Los
modelos v1 siguen importándose, sin reescribir sus identidades ni sus pruebas.
Esto evita duplicar y escapar todo el historial en cada ajuste sucesivo; no
elimina el coste de historiales muy profundos ni acredita mejora competitiva.

Una emisión aprendida sobre un ataque ya activo puede carecer de resultado
atribuible. Solo se excluye ese paso si el intento enlazado tiene una única
comprobación nativa de emisión, reserva y legalidad aceptadas, y un aviso de
`ambiguous-commitment` para el mismo objetivo entre el intento y la decisión.
La exclusión conserva el paso original y su razón; no fabrica recompensa ni
aceptación observada. Un pendiente cancelado por el vencedor requiere el cierre
nativo exacto y sus referencias. Los huecos sin prueba y las confirmaciones sin
recibo siguen rechazándose, aunque el resto de la partida haya terminado.

Un WAIT cancelado por una emisión competidora conserva el resultado censurado y
la prueba de esa emisión. La transición marca `observationTruncated`, sin cerrar
el episodio del juego ni calcular shaping para ese resultado. Los límites de
ticks, resets, errores y finales nativos conservan sus comprobaciones de cierre.

Al comparar WAIT y ACT, ambos deben usar recompensas compatibles. Ajustar solo
ACT con derrotas terminales y dejar WAIT con recompensas locales puede cambiar
la acción elegida por diferencia de escala. La calibración exige WAIT realmente
controlados en nuevas partidas de entrenamiento; los fallbacks no se convierten
en ejemplos de WAIT. La cobertura mínima del modelo no acredita mejora.

## Qué evitamos de los otros proyectos

El análisis por proyecto, revisiones y licencias está en
[la auditoría de extracción](hybrid-bot-project-audit.md). Reutilizamos los contratos
y adaptaciones del userscript: objetivos por identidad estable, separación de
esperar/actuar, normalización fija, fronteras observadas, coordinación confirmada,
evaluación emparejada y replay con procedencia.

No importamos pesos incompatibles, contadores artificiales de cobertura, objetivos
privados del servidor ni protocolos de emisión paralelos. No confundimos victoria
por posición inicial con mejora aprendida, muestras con control efectivo, rechazo
de una reserva con emisión ilegal, ni tests de una fixture con fuerza en partidas.
Los sistemas PPO, self-play y encoders completos de otros repositorios no son
modelos ejecutables intercambiables del userscript; requieren contratos y pruebas
propios antes de incorporarlos.

La evaluación completa anterior del modelo táctico entrenado produjo cuatro
pares válidos y cero victorias tanto para baseline como para shadow y learned.
Ese resultado no demuestra mejora ni equivalencia general. Las nuevas extensiones
requieren su propia evaluación antes de recomendar control aprendido.

## Prueba de integración nativa

`test/hybrid-trajectory-native.mts` es una fixture optativa y acotada. La prueba
conecta colección shadow, modelo listo, una acción aprendida aceptada y confirmada,
vencedor oficial, ledger completo, validación de trayectoria y ajuste nativo del
retorno terminal. Comprueba que el modelo de origen no cambia y que el modelo
offline exportado no acepta aprendizaje táctico en vivo.

El mapa, la configuración y el calendario de comprobación de victoria de esta
fixture se declaran y congelan. Su resultado demuestra el funcionamiento del flujo;
no sustituye partidas completas de holdout ni acredita mejora competitiva.
