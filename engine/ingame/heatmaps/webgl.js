  function createHeatmapWebGlShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) {
      return null;
    }

    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  function createHeatmapWebGlRenderer(canvas) {
    const gl =
      canvas.getContext("webgl", {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
      }) ||
      canvas.getContext("experimental-webgl", {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
      });
    if (!gl) {
      return null;
    }

    const vertexShader = createHeatmapWebGlShader(
      gl,
      gl.VERTEX_SHADER,
      `
        attribute vec2 a_center;
        attribute vec2 a_offset;
        attribute float a_radius;
        attribute float a_intensity;
        uniform vec2 u_resolution;
        varying vec2 v_offset;
        varying float v_intensity;

        void main() {
          vec2 position = a_center + a_offset * a_radius;
          vec2 clip = (position / u_resolution) * 2.0 - 1.0;
          gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);
          v_offset = a_offset;
          v_intensity = a_intensity;
        }
      `,
    );
    const fragmentShader = createHeatmapWebGlShader(
      gl,
      gl.FRAGMENT_SHADER,
      `
        precision mediump float;

        uniform int u_palette;
        varying vec2 v_offset;
        varying float v_intensity;

        vec4 gradientColor(vec3 c0, vec3 c1, vec3 c2, float a0, float a1, float a2, float d) {
          if (d <= 0.34) {
            float t = d / 0.34;
            return vec4(mix(c0, c1, t), mix(a0, a1, t));
          }
          float t = (d - 0.34) / 0.66;
          return vec4(mix(c1, c2, clamp(t, 0.0, 1.0)), mix(a1, a2, clamp(t, 0.0, 1.0)));
        }

        void main() {
          float distanceFromCenter = length(v_offset);
          if (distanceFromCenter > 1.0) {
            discard;
          }

          float fade = 1.0 - smoothstep(0.72, 1.0, distanceFromCenter);
          vec4 color;
          if (u_palette == 0) {
            color = gradientColor(
              vec3(239.0, 68.0, 68.0) / 255.0,
              vec3(250.0, 204.0, 21.0) / 255.0,
              vec3(34.0, 197.0, 94.0) / 255.0,
              0.9,
              0.68,
              0.38,
              distanceFromCenter
            );
          } else {
            color = gradientColor(
              vec3(20.0, 184.0, 166.0) / 255.0,
              vec3(250.0, 204.0, 21.0) / 255.0,
              vec3(59.0, 130.0, 246.0) / 255.0,
              0.94,
              0.66,
              0.36,
              distanceFromCenter
            );
          }

          gl_FragColor = vec4(color.rgb, color.a * v_intensity * fade);
        }
      `,
    );

    if (!vertexShader || !fragmentShader) {
      return null;
    }

    const program = gl.createProgram();
    if (!program) {
      return null;
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }

    const buffer = gl.createBuffer();
    if (!buffer) {
      gl.deleteProgram(program);
      return null;
    }

    return {
      gl,
      program,
      buffer,
      centerLocation: gl.getAttribLocation(program, "a_center"),
      offsetLocation: gl.getAttribLocation(program, "a_offset"),
      radiusLocation: gl.getAttribLocation(program, "a_radius"),
      intensityLocation: gl.getAttribLocation(program, "a_intensity"),
      resolutionLocation: gl.getUniformLocation(program, "u_resolution"),
      paletteLocation: gl.getUniformLocation(program, "u_palette"),
    };
  }

  function getHeatmapWebGlRenderer(canvas) {
    const existing = heatmapWebGlRenderers.get(canvas);
    if (existing) {
      return existing;
    }

    const renderer = createHeatmapWebGlRenderer(canvas);
    if (renderer) {
      heatmapWebGlRenderers.set(canvas, renderer);
    }
    return renderer;
  }

  function releaseHeatmapWebGlRenderer(canvas) {
    if (!canvas) return;
    const renderer = heatmapWebGlRenderers.get(canvas);
    if (renderer) {
      renderer.gl.getExtension("WEBGL_lose_context")?.loseContext();
      heatmapWebGlRenderers.delete(canvas);
    }
    heatmapVertexBuffers.delete(canvas);
  }

