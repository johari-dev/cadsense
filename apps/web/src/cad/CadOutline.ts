import * as THREE from "three";

// RGBA8 normals + 32-bit depth: at most 16 MiB per renderer. Color stays in the
// original antialiased framebuffer; only the transparent edge overlay is composited.
const MAX_OUTLINE_PIXELS = 2 * 1024 * 1024;
/** The normal override is only faithful for opaque, front-sided surface geometry. */
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
        material.side !== THREE.FrontSide ||
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
  const normals = new THREE.MeshNormalMaterial();
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
      uniform float near, far, tolerance;
      uniform bool orthographic;
      float viewDepth(vec2 uv) {
        float d = texture2D(depthTexture, uv).r;
        return orthographic ? d * (near - far) - near
          : near * far / ((far - near) * d - far);
      }
      void main() {
        float z = viewDepth(sampleUv);
        vec3 n = normalize(texture2D(normalTexture, sampleUv).rgb * 2.0 - 1.0);
        float edge = 0.0;
        for (int i = 0; i < 4; i++) {
          vec2 offset = i == 0 ? vec2(pixel.x, 0.0) : i == 1 ? vec2(-pixel.x, 0.0)
            : i == 2 ? vec2(0.0, pixel.y) : vec2(0.0, -pixel.y);
          vec2 uv = sampleUv + offset * 0.65;
          vec3 neighbor = normalize(texture2D(normalTexture, uv).rgb * 2.0 - 1.0);
          float threshold = max(tolerance, abs(z) * 0.002);
          edge = max(edge, smoothstep(threshold, threshold * 2.0, abs(z - viewDepth(uv))));
          if (texture2D(depthTexture, sampleUv).r < 1.0 && texture2D(depthTexture, uv).r < 1.0)
            edge = max(edge, 1.0 - smoothstep(0.55, 0.8, dot(n, neighbor)));
        }
        gl_FragColor = vec4(vec3(0.025), edge * 0.65);
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
  return {
    render: (
      scene: THREE.Scene,
      camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
      sceneSize: number,
    ) => {
      renderer.getDrawingBufferSize(drawingSize);
      const size = cadOutlineSize(drawingSize.x, drawingSize.y);
      if (target.width !== size.width || target.height !== size.height)
        target.setSize(size.width, size.height);
      material.uniforms.pixel!.value.set(1 / size.width, 1 / size.height);
      material.uniforms.near!.value = camera.near;
      material.uniforms.far!.value = camera.far;
      material.uniforms.orthographic!.value = camera instanceof THREE.OrthographicCamera;
      material.uniforms.tolerance!.value = Math.max(sceneSize * 0.001, 1e-9);
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
      normals.dispose();
      quad.geometry.dispose();
      material.dispose();
    },
  };
};
