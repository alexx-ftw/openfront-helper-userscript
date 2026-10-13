# Evaluación Neural: historial completo y control efectivo

Estado: entrenamiento y evaluación completos en ambos equipos. No hay activación ni promoción automática.

## Recuperación de Auto-Bot

Se reprodujo una pérdida de continuidad durante la recarga del userscript: si el motor anterior empezaba a desmontarse y su disposer fallaba, el rollback podía dejar el bot y su panel detenidos. La corrección marca el inicio del desmontaje antes de esperarlo y recupera el motor anterior solo después de comprobar que el candidato no puede seguir emitiendo órdenes. La regresión de fallo parcial y la suite completa pasan; no se elimina la protección contra dos motores simultáneos.

El usuario observa la desaparición del panel y del bot en Chromium del equipo local. La corrección cubre el fallo reproducido; todavía no se ha confirmado que ese sea el desencadenante de su incidente real. La entrega HTTP del userscript corregido se comprobó byte por byte, pero no sustituye observar una partida en ese navegador.

## Experimento congelado

Código `c635add7fa009fab43f27830fe5b83cd33ab4e5f`, motor `f372cdf9451cd8c3dc113aaaf8641e2609e2d3cb`. Dos copias independientes, Linux local y Windows nativo en Porty, sin WSL. Ambos brazos usan compact-neural, frontier-v1, el mismo profesor Legendary integrado, configuración y 112 semillas nuevas declaradas antes del lanzamiento. El local conserva el control original; Porty usa `target-value-v1`. Cada brazo se compara con su propio baseline; la comparación directa entre brazos está confundida con equipo y runtime.

Configuración nativa comprobada: Onion Normal, Free For All, cuatro Nations Impossible, 32 tribus, autoBuild activo y sin modificadores públicos. No es una prueba de admisión del servidor ni de funcionamiento online. El baseline es nuestro Legendary integrado, no un paquete histórico independiente.

La colección termina por el límite declarado de semillas, no en el primer modelo preparado. Solo el modelo final puede pasar a ocho semillas independientes en tres modalidades: baseline, shadow y learned. Los errores, partidas truncadas y evidencia no verificada no se convierten en derrotas. La evaluación desactiva aprendizaje y comprueba las fuentes antes y después de cada ejecución.

## Resultado local

112 partidas de colección completas: 112 aceptadas, cero errores y cero cortes por horizonte. Modelo final preparado con 53 muestras WAIT y 32 ACT/target; se verificaron cambios reales de parámetros, no solo contadores.

| Modalidad          | Victorias | Partidas completas |
| ------------------ | --------: | -----------------: |
| Legendary baseline |         0 |                  8 |
| Neural shadow      |         0 |                  8 |
| Neural learned     |         0 |                  8 |

Las 24 partidas terminaron por ganador, sin errores, exclusiones por horizonte ni evidencia no verificada. Dentro de cada semilla coinciden ganador, ticks, estado final, construcciones e intents emitidos/acumulados. Los 24 modelos finales permanecen iguales al modelo congelado. No se demuestra ventaja; ocho resultados iguales no prueban equivalencia general.

## Diagnóstico con registros originales

- Los 112 archivos incrementales de admisión están presentes: 148.379 intentos, 27.916 emisiones. Los principales bloqueos son falta de tropas disponibles (50.658), reserva de captura insuficiente (39.351), autorización de objetivo (16.350) y refuerzo insuficiente (4.509). Son intentos del bot completo, no muestras independientes ni ataques estratégicos elegibles de Neural.
- Learned intervino en 6 de 1.462 decisiones: seis ataques aceptados, cero WAIT controlados y 1.456 fallbacks. Los registros contienen 1.256 decisiones sin objetivo financiable y 200 sin objetivo nativo elegible.
- Las comprobaciones individuales de objetivos registran 1.743 rechazos por reserva de captura insuficiente y 168 por refuerzo insuficiente, además de 66 duplicados pendientes y ocho por límite de apetito de guerra. Un paso puede comprobar varios objetivos: estos recuentos no son decisiones independientes ni emisiones inseguras. No reducir reservas para aumentar artificialmente la actividad del modelo.
- Las seis aceptaciones no generaron recibos atribuibles nuevos. El primer caso vincula cada dispatch con `ambiguous-commitment`: reforzaba un ataque existente. El contador de aceptación reconoce el booleano real del sender; no se transforma en confirmación o muestra de entrenamiento.
- La colección produce 53 WAIT válidos (20 positivos, 33 cero), 32 ACT válidos (30 positivos, dos negativos) y 44 observaciones canceladas sin etiqueta. Las muestras finales coinciden exactamente con los resultados válidos; ninguna cancelación se entrena como WAIT ficticio.
- La mediana de duración observada es un tick para WAIT y 94,5 para ACT. Presión entrante y compromisos previos no varían en las muestras ACT. Esto limita calibración y cobertura; no autoriza modificar recompensas retrospectivamente ni inventar ejemplos negativos.
- Mediana de decisión: 1,17 ms; máximo: 5,22 ms, a partir de 1.462 eventos originales. No se declaró un límite de aceptación de latencia. En este brazo, más CPU no corrige la escasa cobertura de intervención.

Seguridad medida, alcance `learned-attack-gate`: seis comprobaciones de reserva, cero violaciones; seis comprobaciones de legalidad, cero emisiones ilegales. La cobertura ejercitada es pequeña y no certifica toda la seguridad del bot. Reservas y legalidad permanecen intactas.

## Resultado de Porty y comparación

Windows nativo completó otros 112 juegos de colección, sin errores ni cortes, y los 24 de evaluación: ocho celdas completas, cero errores, cero exclusiones por horizonte y cero ejecuciones no verificadas. Cada modalidad obtuvo cero victorias de ocho. Dentro de cada semilla coinciden ganador, ticks, estado final, construcciones e intents emitidos/acumulados, igual que en el brazo local.

La variante `target-value-v1` compara la utilidad del mejor objetivo con WAIT, en vez de decidir ACT primero. En estas partidas tampoco aumentó el control efectivo: seis ataques aceptados, cero confirmados, cero WAIT controlados y 1.456 fallbacks; 1.256 decisiones sin objetivo financiable y 200 sin objetivo elegible. Sus seis comprobaciones de reserva y seis de legalidad no registran violaciones ni emisiones ilegales, con el mismo alcance limitado. Los 24 modelos permanecieron congelados, aprendizaje desactivado y fuentes verificadas antes y después de cada ejecución.

Los tres objetos de parámetros entrenados son iguales en ambos modelos; sus identidades difieren por el contrato de selección. Ambos recogieron 53 WAIT y 32 ACT/target mediante el mismo profesor en shadow. Cambiar el selector no cambia por sí solo lo que enseña esa colección. La escasez de contextos distintos, el horizonte de recompensa desigual y las intervenciones que refuerzan ataques existentes siguen siendo límites observados. No se atribuyen a falta de CPU ni se corrigen debilitando reservas o inventando confirmaciones.

Total: 224 juegos de entrenamiento y 48 de evaluación completos. Son ocho semillas de evaluación compartidas por ambos brazos, no dieciséis semillas independientes. La diferencia de victorias emparejada es cero; el bootstrap descriptivo declarado (95 %, 10.000 remuestreos) devuelve [0, 0] y todas las parejas empatan. Esa degeneración no demuestra equivalencia general ni suficiente potencia para detectar mejoras. Ningún modelo se activa o promociona.

## Evidencia y recomendación

Raíz de declaración y auditorías: `/home/eros/.local/state/ofh-evaluation/20261013-n4-autobot-recovery`. Declaración `preregistered-plan.v3.json`: SHA256 `da554f3e03ed5b398b5199f4637620c9fa8e14356393d67387b2a674177e017c`.

Resultado local original: `/home/eros/.local/state/ofh-evaluation/20261013-n4-legacy/result.json`, SHA256 `f3fb20c64a09f7fe088955b68dc6d97ddfcd3a2c13c9304884b5e1527824d3a0`. Modelo original: `collection-27/trained-model.json`, SHA256 `06d867b6ea69862db344bd59d4e2a278679dff82af4cbd7438436946114130e2`, modelHash `21577c8a4490a92569b4ec1346c73e69a5c1e64a32cd721f51728dff4d7430e6`.

Resultado original de Porty: `C:/Users/Eros/ofh-evaluation/20261013-n4-target-value/result.json`, SHA256 `ececd46e5c92a3873263b93c604c1b0f6dbc30e17ad307532f1c62ddc592c593`. Copia íntegra local: `porty-final-result-original.json` en la raíz de auditoría. Modelo original: `collection-27/trained-model.json`, SHA256 `6a925dfdba66fe50d33174028d69af3ff5fa285394e48f634ab0338c1c564a40`, modelHash `4f6b28ea5b8c6526d224685ab03947f019a534e8ecd4d773a9364eb8d05b3c09`. Las 28 exportaciones de cada brazo conservan exactamente la secuencia acumulada de semillas originales; los modelos y manifests no se reescribieron.

Mantener Legendary como opción predeterminada. Shadow sirve para observar y recoger ejemplos reales; esta evaluación no justifica activar learned para ganar más, ni preferir `target-value-v1`. Antes de otro experimento haría falta resolver la atribución de refuerzos y ampliar contextos/recompensas con evidencia real y una nueva declaración independiente. Este informe no autoriza modificar los modelos congelados ni sus controles de seguridad.
