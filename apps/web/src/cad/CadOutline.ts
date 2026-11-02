import * as THREE from "three";

// RGBA8 normals + 32-bit depth: at most 16 MiB per renderer. Color stays in the
// original antialiased framebuffer; only the transparent edge overlay is composited.
const MAX_OUTLINE_PIXELS = 2 * 1024 * 1024;
/**
 * The normal override is only faithful for opaque surface geometry. Double-sided surfaces are
 * fine: the override is double-sided too and flips back-face normals the way shading does.
 */
export const supportsCadOutline = (root: THREE.Object3D) => {
  let supported = true;
  root.traverse((object) => {
    if (object instanceof THREE.Line || object instanceof THREE.Points) supported = false;
    if (!(object instanceof THREE.Mesh)) return;
    if (!object.geometry.getAttribute("normal")) supported = false;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (
        !(
          material instanceof THREE.MeshStandardMaterial ||
          material instanceof THREE.MeshBasicMaterial
        ) ||
        material.transparent ||
        material.opacity !== 1 ||
        material.alphaTest > 0 ||
        material.alphaHash ||
        (material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0) ||
        material.side === THREE.BackSide ||
        !material.depthTest ||
        !material.depthWrite
      )
        supported = false;
    }
  });
  return supported;
};
export const cadOutlineSize = (width: number, height: number) => {
  const scale = Math.min(1, Math.sqrt(MAX_OUTLINE_PIXELS / (width * height)));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
};

/** Screen-space silhouettes and creases. Owns no topology cache or animation loop. */
export const createCadOutline = (renderer: THREE.WebGLRenderer) => {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
  });
  const normals = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      normalTexture: { value: target.texture },
      depthTexture: { value: target.depthTexture },
      pixel: { value: new THREE.Vector2(1, 1) },
      near: { value: 0.001 },
      far: { value: 1 },
      orthographic: { value: false },
      tolerance: { value: 0.0002 },
      silhouette: { value: 0.01 },
    },
    vertexShader: `
      varying vec2 sampleUv;
      void main() {
        sampleUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 sampleUv;
      uniform sampler2D normalTexture, depthTexture;
      uniform vec2 pixel;
      uniform float near, far, tolerance, silhouette;
      uniform bool orthographic;
      const float CREASE = 0.35;
      float viewDepth(vec2 uv) {
        float d = texture2D(depthTexture, uv).r;
        return orthographic ? d * (near - far) - near
          : near * far / ((far - near) * d - far);
      }
      void main() {
        float z = viewDepth(sampleUv);
        bool solid = texture2D(depthTexture, sampleUv).r < 1.0;
        vec3 n = normalize(texture2D(normalTexture, sampleUv).rgb * 2.0 - 1.0);
        // Silhouettes (the model against the backdrop, or a part well in front of what is
        // behind it) draw at full strength. Creases, and the small depth steps at hole rims and
        // fine features, draw at CREASE strength so they stop competing with pins and outlines.
        float edge = 0.0;
        for (int i = 0; i < 4; i++) {
          vec2 offset = i == 0 ? vec2(pixel.x, 0.0) : i == 1 ? vec2(-pixel.x, 0.0)
            : i == 2 ? vec2(0.0, pixel.y) : vec2(0.0, -pixel.y);
          vec2 uv = sampleUv + offset * 0.65;
          bool neighborSolid = texture2D(depthTexture, uv).r < 1.0;
          if (solid != neighborSolid) {
            edge = 1.0;
            continue;
          }
          if (!solid) continue;
          vec3 neighbor = normalize(texture2D(normalTexture, uv).rgb * 2.0 - 1.0);
          float gap = abs(z - viewDepth(uv));
          float threshold = max(tolerance, abs(z) * 0.002);
          float depthEdge = smoothstep(threshold, threshold * 2.0, gap);
          float strength = mix(CREASE, 1.0, smoothstep(silhouette, silhouette * 2.0, gap));
          edge = max(edge, depthEdge * strength);
          edge = max(edge, (1.0 - smoothstep(0.55, 0.8, dot(n, neighbor))) * CREASE);
        }
        // A charcoal line rather than black: strong on light parts, quiet on dark ones, and
        // barely visible where a silhouette meets the dark backdrop.
        gl_FragColor = vec4(vec3(0.14), edge * 0.65);
      }
    `,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  const overlay = new THREE.Scene();
  overlay.add(quad);
  const overlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const drawingSize = new THREE.Vector2();
  const clearColor = new THREE.Color();
  const backgroundNormal = new THREE.Color(0.5, 0.5, 1);
  // The highlight rim: the highlighted meshes' depth alone, compared against the full scene's
  // depth from the normal pass, marks where a highlighted part is the visible surface. A light
  // blue line traces the boundary of that region, so a selected part stands apart from the
  // flat-colored pins on it and from parts of a similar tone around it.
  const mask = new THREE.WebGLRenderTarget(1, 1, {
    depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
  });
  const maskDepth = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false });
  const rim = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      sceneDepth: { value: target.depthTexture },
      maskDepth: { value: mask.depthTexture },
      pixel: material.uniforms.pixel!,
      near: material.uniforms.near!,
      far: material.uniforms.far!,
      orthographic: material.uniforms.orthographic!,
      tolerance: material.uniforms.tolerance!,
    },
    vertexShader: material.vertexShader,
    fragmentShader: `
      varying vec2 sampleUv;
      uniform sampler2D sceneDepth, maskDepth;
      uniform vec2 pixel;
      uniform float near, far, tolerance;
      uniform bool orthographic;
      float viewDepth(float d) {
        return orthographic ? d * (near - far) - near : near * far / ((far - near) * d - far);
      }
      // Whether the highlighted part is the visible surface at uv.
      float shown(vec2 uv) {
        float m = texture2D(maskDepth, uv).r;
        if (m >= 1.0) return 0.0;
        float z = viewDepth(texture2D(sceneDepth, uv).r);
        return abs(viewDepth(m) - z) <= max(tolerance, abs(z) * 0.003) ? 1.0 : 0.0;
      }
      void main() {
        float center = shown(sampleUv);
        float edge = 0.0;
        for (int i = 0; i < 8; i++) {
          float angle = float(i) * 0.7853982;
          edge = max(edge, abs(center - shown(sampleUv + vec2(cos(angle), sin(angle)) * pixel * 1.5)));
        }
        gl_FragColor = vec4(0.74, 0.87, 1.0, edge * 0.95);
      }
    `,
  });
  const rimScene = new THREE.Scene();
  rimScene.add(new THREE.Mesh(quad.geometry, rim));
  return {
    /**
     * Draws edges over the frame `camera` just rendered. With `highlightLayer`, also rims the
     * meshes on that layer where they are visible.
     */
    render: (
      scene: THREE.Scene,
      camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
      sceneSize: number,
      highlightLayer?: number,
    ) => {
      renderer.getDrawingBufferSize(drawingSize);
      const size = cadOutlineSize(drawingSize.x, drawingSize.y);
      if (target.width !== size.width || target.height !== size.height)
        target.setSize(size.width, size.height);
      if (
        highlightLayer !== undefined &&
        (mask.width !== size.width || mask.height !== size.height)
      )
        mask.setSize(size.width, size.height);
      material.uniforms.pixel!.value.set(1 / size.width, 1 / size.height);
      material.uniforms.near!.value = camera.near;
      material.uniforms.far!.value = camera.far;
      material.uniforms.orthographic!.value = camera instanceof THREE.OrthographicCamera;
      material.uniforms.tolerance!.value = Math.max(sceneSize * 0.001, 1e-9);
      // Depth steps past 4% of the model's size separate distinct parts (a full-strength edge);
      // smaller ones are hole rims and fine features.
      material.uniforms.silhouette!.value = Math.max(sceneSize * 0.04, 1e-9);
      const previousTarget = renderer.getRenderTarget();
      const previousOverride = scene.overrideMaterial;
      const previousBackground = scene.background;
      const autoClear = renderer.autoClear;
      const clearAlpha = renderer.getClearAlpha();
      renderer.getClearColor(clearColor);
      try {
        scene.background = null;
        scene.overrideMaterial = normals;
        renderer.autoClear = true;
        // A background normal of +Z avoids theme-dependent false edges in empty space.
        renderer.setClearColor(backgroundNormal, 1);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        scene.overrideMaterial = previousOverride;
        scene.background = previousBackground;
        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = false;
        renderer.render(overlay, overlayCamera);
        if (highlightLayer !== undefined) {
          const layers = camera.layers.mask;
          try {
            scene.background = null;
            scene.overrideMaterial = maskDepth;
            camera.layers.set(highlightLayer);
            renderer.autoClear = true;
            renderer.setRenderTarget(mask);
            renderer.render(scene, camera);
          } finally {
            camera.layers.mask = layers;
            scene.overrideMaterial = previousOverride;
            scene.background = previousBackground;
            renderer.setRenderTarget(previousTarget);
            renderer.autoClear = false;
          }
          renderer.render(rimScene, overlayCamera);
        }
      } finally {
        scene.overrideMaterial = previousOverride;
        scene.background = previousBackground;
        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = autoClear;
        renderer.setClearColor(clearColor, clearAlpha);
      }
    },
    dispose: () => {
      target.dispose();
      mask.dispose();
      maskDepth.dispose();
      rim.dispose();
      normals.dispose();
      quad.geometry.dispose();
      material.dispose();
    },
  };
};
