import '@playcanvas/web-components';
import { shaderChunks, Asset, BoundingBox, Ray, Color, EventHandler, Mat4, MiniStats, Vec3, Quat, Entity, BoundingSphere, Layer, StandardMaterial, BLEND_NORMAL, EVENT_MOUSEDOWN } from 'playcanvas';
import { migrateSettings } from './data-migrations.js';
import { FlyCamera } from './fly-camera.js';
import { AppController } from './input.js';
import { observe } from './observe.js';
import { OrbitCamera } from './orbit-camera.js';
import { PointerDevice } from './pointer-device.js';
import { Pose } from './pose.js';

const url = new URL(location.href);
var activePose = new Pose();
// support overriding parameters by query param
const paramOverrides = {
    noanim: true
};

// get experience parameters
const params = {
    ...(window.sse?.params ?? {}),
    ...paramOverrides
};

const gsplatFS = /* glsl */ `
varying mediump vec2 gaussianUV;
varying mediump vec4 gaussianColor;

void main(void) {
    mediump float A = dot(gaussianUV, gaussianUV);
    if (A > 1.0) {
        discard;
    }

    // evaluate alpha
    mediump float alpha = exp(-A * 4.0) * gaussianColor.a;

    #ifdef PICK_PASS
        if (alpha < 0.1) {
            discard;
        }
        gl_FragColor = packFloat(gl_FragCoord.z);
    #else
        if (alpha < 1.0 / 255.0) {
            discard;
        }

        #ifndef DITHER_NONE
            opacityDither(alpha, id * 0.013);
        #endif

        gl_FragColor = vec4(gaussianColor.xyz * alpha, alpha);
    #endif
}
`;

// render skybox as plain equirect
shaderChunks.gsplatCenterVS = /* glsl */ `
uniform mat4 matrix_model;
uniform mat4 matrix_view;
uniform mat4 matrix_projection;

// project the model space gaussian center to view and clip space
bool initCenter(vec3 modelCenter, out SplatCenter center) {
    mat4 modelView = matrix_view * matrix_model;
    vec4 centerView = modelView * vec4(modelCenter, 1.0);

    // early out if splat is behind the camera
    if (centerView.z > 0.0) {
        return false;
    }

    vec4 centerProj = matrix_projection * centerView;

    // ensure gaussians are not clipped by camera near and far
    centerProj.z = clamp(centerProj.z, -abs(centerProj.w), abs(centerProj.w));

    center.view = centerView.xyz / centerView.w;
    center.proj = centerProj;
    center.projMat00 = matrix_projection[0][0];
    center.modelView = modelView;
    return true;
}
`;
shaderChunks.skyboxPS = shaderChunks.skyboxPS.replace('mapRoughnessUv(uv, mipLevel)', 'uv');

const v = new Vec3();
const pose = new Pose();

window.bblock = false;

class Viewer {
    constructor(app, entity, events, state, settings) {
        const { background, camera } = settings;
        const { graphicsDevice } = app;

        this.app = app;
        this.entity = entity;
        this.events = events;
        this.state = state;
        this.settings = settings;
        this.skipUpdate = false; // Flag to skip update loop after click
        this.targetPose = null; // Target pose for smooth transition
        this.transitionTimer = 0; // Timer for POI lerp transition
        this.POISpeed = .2; // Exposed variable to control transition speed (higher = faster)
        this.transitionDuration = 1 / this.POISpeed; // Duration of POI transition in seconds
        this.cameraTransitionDuration = this.transitionDuration; // Duration for camera mode transitions

        // Initialize camera instances
        this.cameras = {
            orbit: new OrbitCamera(),
            fly: new FlyCamera(),
            // anim: createAnimCamera(userStart, isObjectExperience), // Uncomment if animCamera is defined
        };

        // Disable auto render – only render on camera change
        app.autoRender = true;

        // Create and insert a new layer after the World layer
        const frontLayer = new Layer({ name: 'Front Layer' });
        const worldLayer = app.scene.layers.getLayerByName('World');
        const worldLayerIdx = app.scene.layers.getTransparentIndex(worldLayer);
        app.scene.layers.insert(frontLayer, worldLayerIdx + 1);

        // Set the camera to render both World and Front Layer
        entity.camera.clearColor = new Color(background.color);
        entity.camera.fov = camera.fov;
        entity.camera.layers = [worldLayer.id, frontLayer.id];

  

        const greenUnlit = new StandardMaterial();
        greenUnlit.useLighting = false;
        greenUnlit.opacity = 0.4;
        greenUnlit.emissive.set(0, 1, 0);
        greenUnlit.emissiveIntensity = 1;
        greenUnlit.blendType = BLEND_NORMAL;
        greenUnlit.update();

        const transforms = [
            {
                name: "Box1",
                position: [-1.44, 3.60, 0.50],
                rotation: [0.00, -22.31, 0.00],
                scale: [0.74, 0.24, 0.75],
                front: [-3.81, 3.60, -0.60]
            },
            {
                name: "Box2",
                position: [0.30, 4.21, -0.81],
                rotation: [0.00, -22.31, 0.00],
                scale: [0.74, 0.24, 0.75],
                front: [0.97, 4.21, -2.77]
            },
        ];

        const boxes = [];

        transforms.forEach((data) => {
            const box = new Entity(data.name);
            box.addComponent('render', { type: 'box' });
            box.setPosition(...data.position);
            box.setLocalScale(...data.scale);
            box.setEulerAngles(...data.rotation);
            box.render.material = greenUnlit;
            box.render.layers = [worldLayer.id, frontLayer.id];
            box.userData = {
                isBig: false,
                originalScale: new Vec3(...data.scale),
                front: data.front
            };
            app.root.addChild(box);
            boxes.push(box);
        });

        app.mouse.on(EVENT_MOUSEDOWN, (event) => {
            const cameraEntity = app.root.findByName('camera');
            if (!cameraEntity || !cameraEntity.camera) return;

            const camera = cameraEntity.camera;
            const from = camera.screenToWorld(event.x, event.y, camera.nearClip);
            const to = camera.screenToWorld(event.x, event.y, camera.farClip);
            const direction = to.sub(from).normalize();
            const ray = new Ray(from, direction);

            boxes.forEach((box) => {
                if (box.render && box.render.type === 'box') {
                    const aabb = box.render.meshInstances[0].aabb;
                    if (aabb.intersectsRay(ray)) {
                        console.log(`Moving camera to ${box.name}`);

                        // Create pose to look at box's front position
                        const targetPos = new Vec3(...box.userData.front);
                        const boxPos = box.getPosition();

                        const newPose = new Pose().fromLookAt(
                            new Vec3(...box.userData.front), // camera position
                            boxPos                           // target position
                        );

                        // Force camera mode to fly if not already
                        if (state.cameraMode !== 'fly') {
                            events.fire('cameraMode:changed', 'fly', state.cameraMode);
                            state.cameraMode = 'fly';
                        }

                        // Set target pose for smooth transition
                        this.targetPose = newPose;
                        this.transitionTimer = 0; // Reset transition timer
                        console.log("targetPose.position:", this.targetPose.position);

                        const ui = document.getElementById('unit-ui');
                        ui.style.display = 'block';
                        
                        
                    }
                }
            });
        });

        // handle horizontal fov on canvas resize
        const updateHorizontalFov = () => {
            this.entity.camera.horizontalFov = graphicsDevice.width > graphicsDevice.height;
        };
        graphicsDevice.on('resizecanvas', () => {
            updateHorizontalFov();
            app.renderNextFrame = true;
        });
        updateHorizontalFov();

        // track camera changes
        const prevProj = new Mat4();
        const prevWorld = new Mat4();

        app.on('framerender', () => {
            const world = this.entity.getWorldTransform();
            const proj = this.entity.camera.projectionMatrix;
            const nearlyEquals = (a, b, epsilon = 1e-4) => {
                return !a.some((v, i) => Math.abs(v - b[i]) >= epsilon);
            };

            if (!app.autoRender && !app.renderNextFrame) {
                if (!nearlyEquals(world.data, prevWorld.data) ||
                    !nearlyEquals(proj.data, prevProj.data)) {
                    app.renderNextFrame = true;
                }
            }

            if (app.renderNextFrame) {
                prevWorld.copy(world);
                prevProj.copy(proj);
            }

            // suppress rendering till we're ready
            if (!state.readyToRender) {
                app.renderNextFrame = false;
            }
        });
        graphicsDevice.maxPixelRatio = state.hqMode ? window.devicePixelRatio : 1;

        // initialize the viewer after assets have finished loading
        events.on('loaded', () => this.initialize());
    }

    // Get camera instance by mode
    getCamera(cameraMode) {
        return this.cameras[cameraMode];
    }

    // Reassign controller to ensure input is processed
    assignController() {
        const controller = window.controller;
        const pointerDevice = this.app.graphicsDevice.canvas.__pointerDevice;
        if (!controller || !pointerDevice) return;

        switch (this.state.cameraMode) {
            case 'orbit':
                pointerDevice.target = this.state.inputMode === 'touch' ? controller.orbit : controller.desktop;
                break;
            case 'anim':
                pointerDevice.target = null;
                break;
            case 'fly':
                pointerDevice.target = this.state.inputMode === 'touch' ? controller.touch : controller.desktop;
                break;
        }
        console.log("Controller reassigned for mode:", this.state.cameraMode, "inputMode:", this.state.inputMode);
    }

    // initialize the viewer once gsplat asset is finished loading
    initialize() {
        const { app, entity, events, state, settings } = this;

        // get the gsplat
        const gsplat = app.root.findComponent('gsplat');

        // calculate scene bounding box
        const bbox = gsplat?.instance?.meshInstance?.aabb ?? new BoundingBox();

        // override gsplat shader for picking
        const { instance } = gsplat;
        instance.createMaterial({
            fragment: gsplatFS
        });

        // calculate the orbit camera frame position
        const framePose = (() => {
            const sceneSize = bbox.halfExtents.length();
            const distance = sceneSize / Math.sin(entity.camera.fov / 180 * Math.PI * 0.5);
            return new Pose().fromLookAt(
                new Vec3(2, 1, 2).normalize().mulScalar(distance).add(bbox.center),
                bbox.center
            );
        })();

        // calculate the orbit camera reset position
        const resetPose = (() => {
            const { position, target } = this.settings.camera;
            return new Pose().fromLookAt(
                new Vec3(position ?? [0, 1, 0]),
                new Vec3(target ?? [0, 0, 0])
            );
        })();

        // calculate the user camera start position
        const useReset = settings.camera.position || settings.camera.target || bbox.halfExtents.length() > 100;
        const userStart = new Pose(useReset ? resetPose : framePose);

        // if camera doesn't intersect the scene, assume it's an object we're viewing
        const isObjectExperience = !bbox.containsPoint(userStart.position);

        // set fly speed based on scene size, within reason
        this.cameras.fly.moveSpeed = 0.05; // Math.max(0.05, Math.min(1, bbox.halfExtents.length() * 0.0001));

        // set the global animation flag
        state.cameraMode = 'fly';

        // initialize activePose
        activePose.copy(userStart);

        // place all user cameras at the start position
        this.cameras.orbit.reset(activePose);

        const euler = new Vec3();
        activePose.rotation.getEulerAngles(euler);
        euler.x = 0; // zero the pitch
        euler.z = 0; // optional: zero the roll
        activePose.rotation.setFromEulerAngles(euler.x, euler.y, euler.z);

        this.cameras.fly.reset(activePose);

        // create the pointer device
        const pointerDevice = new PointerDevice(app.graphicsDevice.canvas);
        app.graphicsDevice.canvas.__pointerDevice = pointerDevice; // Store for later access
        const controller = new AppController();

        window.controller = controller;

        // transition time between cameras
        let cameraTransitionTimer = 0;

        // the previous camera we're transitioning away from
        const prevPose = new Pose();
        let prevCamera = null;
        let prevCameraMode = 'fly';

        // initial controller assignment
        this.assignController();

        // handle input mode changing
        events.on('inputMode:changed', (value, prev) => {
            this.assignController();
        });

        app.on('update', (deltaTime) => {
            // in xr mode we leave the camera alone
            if (app.xr.active) {
                return;
            }

            // update input controller
            controller.update(deltaTime);

            // remap some desktop inputs based on camera mode
            if (state.cameraMode === 'orbit') {
                const { value } = controller.desktop.left.inputs[1];
                controller.left.value[0] -= value[0] * 2;
                controller.left.value[1] -= value[1] * 2;
            } else if (state.cameraMode === 'fly') {
                const { value } = controller.desktop.left.inputs[0];
                controller.left.value[1] -= value[1];
                controller.left.value[2] += value[1];
            }

            controller.touch.left.base = [window.innerWidth - 96, window.innerHeight - 96, 0];
            controller.touch.right.base = [96, window.innerHeight - 96, 0];

            // update the active camera
            const input = {
                move: controller.left,
                rotate: controller.right,
                pinchActive: controller.touch?.pinchActive?.(),
                isTouch: state.inputMode === 'touch'
            };

          
            const activeCamera = this.getCamera(state.cameraMode);
            activeCamera.update(deltaTime, state.cameraMode !== 'anim' && input);
            activeCamera.getPose(pose);

         
            // controls have been consumed
            controller.clear();

            // handle smooth transition to target pose
            if (this.targetPose) {
                this.transitionTimer += deltaTime / this.transitionDuration;
                if (this.transitionTimer >= this.POISpeed) {
                    // Transition complete
                    activePose.copy(this.targetPose);
                    this.getCamera('fly').reset(activePose); // Reset FlyCamera to final pose
                    this.targetPose = null; // Clear target pose
                    this.transitionTimer = 0;
                    cameraTransitionTimer = this.POISpeed; // Ensure camera transition is complete
                    this.assignController(); // Reassign controller to ensure input
                    console.log("POI transition complete, FlyCamera reset to:", activePose.position);
                } else {
                    // Interpolate position and rotation
                    const t = this.transitionTimer; // Linear interpolation
                    // Optional easing: const t = 1 - Math.pow(1 - this.transitionTimer, 2); // Ease-out
                    activePose.position.lerp(activePose.position, this.targetPose.position, t);
                    activePose.rotation.slerp(activePose.rotation, this.targetPose.rotation, t);
                }
            } else {
                // Normal camera update
                if (this.skipUpdate) {
                    this.skipUpdate = false; // Reset flag
                } else {
                    // blend camera smoothly during camera mode transitions
                    if (cameraTransitionTimer < 1) {
                        cameraTransitionTimer = Math.min(1, cameraTransitionTimer + deltaTime / this.cameraTransitionDuration);

                        if (cameraTransitionTimer < 1 && prevCamera) {
                            const x = cameraTransitionTimer;
                            // ease out exponential
                            const norm = 1 - (2 ** -10);
                            const weight = (1 - (2 ** (-10 * x))) / norm;
                            pose.lerp(prevPose, pose, weight);
                        }
                    }

                    // snap camera
                    activePose.copy(pose);
                }
            }

            // apply to camera
            entity.setPosition(activePose.position);
            entity.setRotation(activePose.rotation);
        });

        // handle camera mode switching
        events.on('cameraMode:changed', (value, prev) => {
            prevCameraMode = prev;
            prevCamera = this.getCamera(prev);
            prevCamera.getPose(prevPose);

            switch (value) {
                case 'orbit':
                case 'fly':
                    this.getCamera(value).reset(activePose);
                    break;
            }

            // reset camera transition timer
            cameraTransitionTimer = 0;

            // reassign controller
            this.assignController();
        });

        events.on('setAnimationTime', (time) => {
            if (this.cameras.anim) {
                this.cameras.anim.cursor.value = time;

                // switch to animation camera if we're not already there
                if (state.cameraMode !== 'anim') {
                    state.cameraMode = 'anim';
                }
            }
        });

        // initialize the camera entity to initial position and kick off the first scene sort
        entity.setPosition(activePose.position);
        entity.setRotation(activePose.rotation);
        gsplat?.instance?.sort(entity);

        // handle gsplat sort updates
        gsplat?.instance?.sorter?.on('updated', () => {
            // request frame render when sorting changes
            app.renderNextFrame = true;

            if (!state.readyToRender) {
                // we're ready to render once the first sort has completed
                state.readyToRender = true;

                // wait for the first valid frame to complete rendering
                const frameHandle = app.on('frameend', () => {
                    frameHandle.off();

                    events.fire('firstFrame');

                    // emit first frame event on window
                    window.firstFrame?.();
                });
            }
        });
    }
}

const loadContent = (appElement) => {
    const { app } = appElement;
    const { contentUrl } = window.sse;

    const asset = new Asset('scene.compressed.ply', 'gsplat', {
        url: contentUrl,
        filename: 'scene.compressed.ply'
    });

    asset.on('load', () => {
        const entity = asset.resource.instantiate();
        app.root.addChild(entity);
    });

    asset.on('error', (err) => {
        console.log(err);
    });

    app.assets.add(asset);
    app.assets.load(asset);
};

document.addEventListener('DOMContentLoaded', async () => {
    const appElement = document.querySelector('pc-app');
    const app = (await appElement.ready()).app;

    loadContent(appElement);

    const cameraElement = await document.querySelector('pc-entity[name="camera"]').ready();
    const camera = cameraElement.entity;
    const settings = migrateSettings(await window.sse?.settings);
    const events = new EventHandler();
    const state = observe(events, {
        readyToRender: false,
        hqMode: true,
        progress: 0,
        inputMode: 'desktop',
        cameraMode: 'fly',
        hasAnimation: false,
        animationDuration: 0,
        animationTime: 0,
        animationPaused: params.noanim,
        hasAR: false,
        hasVR: false,
        isFullscreen: false,
        uiVisible: true
    });

    const viewer = new Viewer(app, camera, events, state, settings);

    // wait for gsplat asset to load before initializing the rest
    const assets = app.assets.filter(asset => asset.type === 'gsplat');
    if (assets.length > 0) {
        const asset = assets[0];

        asset.on('progress', (received, length) => {
            state.progress = (Math.min(1, received / length) * 100).toFixed(0);
        });

        if (asset.loaded) {
            events.fire('loaded', asset);
        } else {
            asset.on('load', () => {
                events.fire('loaded', asset);
            });
        }
    }
});