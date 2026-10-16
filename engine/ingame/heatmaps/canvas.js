  function removeHeatmapContainer(containerId, canvasClass) {
    const container = document.getElementById(containerId);
    if (!container) return;
    releaseHeatmapWebGlRenderer(container.querySelector(`.${canvasClass}`));
    container.remove();
  }

  function clearHeatmapCanvas(canvas) {
    const renderer = getHeatmapWebGlRenderer(canvas);
    if (renderer && !renderer.gl.isContextLost?.()) {
      renderer.gl.viewport(0, 0, canvas.width, canvas.height);
      renderer.gl.clearColor(0, 0, 0, 0);
      renderer.gl.clear(renderer.gl.COLOR_BUFFER_BIT);
      return;
    }

    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  }

  function getUsableHeatmapRenderer(canvas) {
    const renderer = getHeatmapWebGlRenderer(canvas);
    if (
      !renderer ||
      renderer.centerLocation < 0 ||
      renderer.offsetLocation < 0 ||
      renderer.radiusLocation < 0 ||
      renderer.intensityLocation < 0
    ) return null;
    if (!renderer.gl.isContextLost?.()) return renderer;
    heatmapWebGlRenderers.delete(canvas);
    return null;
  }

  function renderHeatmapPointsWebGl(options) {
    const { canvas, points, maxWeight, pixelRatio, palette, getShape } = options;
    const renderer = getUsableHeatmapRenderer(canvas);
    if (!renderer) return false;

    const { gl, program, buffer } = renderer;

    const quadOffsets = [
      -1, -1,
      1, -1,
      -1, 1,
      -1, 1,
      1, -1,
      1, 1,
    ];
    const floatsPerVertex = 6;
    const verticesPerPoint = 6;
    const floatsNeeded = points.length * verticesPerPoint * floatsPerVertex;
    const data = _ensureHeatmapVertexBuffer(canvas, floatsNeeded);
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const shape = getShape(point, maxWeight, pixelRatio);
      const centerX = point.x * pixelRatio;
      const centerY = point.y * pixelRatio;
      const radius = shape.radius;
      const intensity = shape.intensity;
      const baseOffset = index * verticesPerPoint * floatsPerVertex;
      for (let vertex = 0; vertex < verticesPerPoint; vertex += 1) {
        const offset = baseOffset + vertex * floatsPerVertex;
        data[offset] = centerX;
        data[offset + 1] = centerY;
        data[offset + 2] = quadOffsets[vertex * 2];
        data[offset + 3] = quadOffsets[vertex * 2 + 1];
        data[offset + 4] = radius;
        data[offset + 5] = intensity;
      }
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // Upload only the used slice: data may have growth headroom from the
    // reusable buffer pool. subarray returns a Float32Array view over the
    // same underlying ArrayBuffer (no copy).
    gl.bufferData(
      gl.ARRAY_BUFFER,
      data.length === floatsNeeded ? data : data.subarray(0, floatsNeeded),
      gl.DYNAMIC_DRAW,
    );

    const stride = floatsPerVertex * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(renderer.centerLocation);
    gl.vertexAttribPointer(renderer.centerLocation, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(renderer.offsetLocation);
    gl.vertexAttribPointer(renderer.offsetLocation, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
    gl.enableVertexAttribArray(renderer.radiusLocation);
    gl.vertexAttribPointer(renderer.radiusLocation, 1, gl.FLOAT, false, stride, 4 * Float32Array.BYTES_PER_ELEMENT);
    gl.enableVertexAttribArray(renderer.intensityLocation);
    gl.vertexAttribPointer(renderer.intensityLocation, 1, gl.FLOAT, false, stride, 5 * Float32Array.BYTES_PER_ELEMENT);
    gl.uniform2f(renderer.resolutionLocation, canvas.width, canvas.height);
    gl.uniform1i(renderer.paletteLocation, palette);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, points.length * verticesPerPoint);

    return true;
  }

