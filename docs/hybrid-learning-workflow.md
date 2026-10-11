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

La lectura del archivo incremental admite hasta 64 MiB por partida; superar ese
límite rechaza la evidencia completa. Las decisiones observadas conservan su
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

El resultado debe acreditar ejecución completada, procedencia positiva y revisión
y diff del motor coincidentes al inicio. Una derrota terminal válida puede aportar
retorno negativo; un error, una interrupción o una infracción del presupuesto no
se convierte en una derrota de entrenamiento.

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
