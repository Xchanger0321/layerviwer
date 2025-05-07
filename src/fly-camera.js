import { Vec3, Mat4 } from 'playcanvas';

import { damp, MyQuat } from './math.js';

const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const v = new Vec3();
const q = new MyQuat();

function rayIntersectsTriangle(origin, direction, a, b, c) {
    const edge1 = b.clone().sub(a);
    const edge2 = c.clone().sub(a);
    const h = new Vec3().cross(direction, edge2);
    const det = edge1.dot(h);

    if (det > -0.00001 && det < 0.00001) return false;

    const invDet = 1 / det;
    const s = origin.clone().sub(a);
    const u = invDet * s.dot(h);
    if (u < 0 || u > 1) return false;

    const q = new Vec3().cross(s, edge1);
    const v = invDet * direction.dot(q);
    if (v < 0 || u + v > 1) return false;

    const t = invDet * edge2.dot(q);
    return t > 0;
}

function isPointInsideMesh(point, meshInstance) {
    const mesh = meshInstance.mesh;
    const worldTransform = meshInstance.node.getWorldTransform();

    // Step 1: Transform point into local space of the mesh
    const localPoint = point.clone();
    const invMat = new Mat4();
    invMat.copy(worldTransform).invert();
    invMat.transformPoint(localPoint, localPoint);

    // Step 2: Setup ray
    const rayStart = localPoint.clone();
    const rayDir = new Vec3(0, 1, 0); // shoot ray upward

    let hits = 0;

    // Step 3: Read index data safely
    const indexBuffer = mesh.indexBuffer[0];
    const indexFormat = indexBuffer.format;
    const indexArray = indexFormat === 2 // pc.INDEXFORMAT_UINT32
        ? new Uint32Array(indexBuffer.storage.slice(0))
        : new Uint16Array(indexBuffer.storage.slice(0));

    // Step 4: Read vertex positions from buffer
    const vertexBuffer = mesh.vertexBuffer;
    const vertexFormat = vertexBuffer.format;
    const stride = vertexFormat.size; // in bytes
    const positionElement = vertexFormat.elements.find(e => e.name === 'POSITION');

    if (!positionElement) {
        console.error('❌ Mesh does not contain "position" data.');
        return false;
    }

    const positions = [];
    const dataView = new DataView(vertexBuffer.storage);
    const vertexCount = vertexBuffer.numVertices;

    for (let i = 0; i < vertexCount; i++) {
        const base = i * stride + positionElement.offset;

        const x = dataView.getFloat32(base, true);
        const y = dataView.getFloat32(base + 4, true);
        const z = dataView.getFloat32(base + 8, true);

        positions.push(new Vec3(x, y, z));
    }

    // Step 5: Perform raycast hit test for each triangle
    for (let i = 0; i < indexArray.length; i += 3) {
        const a = positions[indexArray[i]];
        const b = positions[indexArray[i + 1]];
        const c = positions[indexArray[i + 2]];

        if (rayIntersectsTriangle(rayStart, rayDir, a, b, c)) {
            hits++;
        }
    }

    return hits % 2 === 1; // Odd = inside, even = outside
}

class FlyCamera {
    position = new Vec3();

    rotation = new MyQuat();

    distance = 1;

    smoothPosition = new Vec3();

    smoothRotation = new MyQuat();

    moveSpeed = 0.1;

    rotateSpeed = 0.2;

    targetPosition = null;
    startPosition = null;
    flyElapsed = 0;
    flyDuration = 2; // in seconds

    flyTo(position) {
        this.startPosition = this.position.clone();
        this.targetPosition = position.clone();
        this.targetPosition.y = this.startPosition.y; // lock altitude
        this.flyElapsed = 0;
    }
    
    reset(pose, snap = true) {
        this.position.copy(pose.position);
        this.rotation.copy(pose.rotation);
        this.distance = pose.distance;
        if (snap) {
            this.smoothPosition.copy(pose.position);
            this.smoothRotation.copy(pose.rotation);
        }
    }

    update(dt, input) {
        if (this.targetPosition) {
            this.flyElapsed += dt;
    
            const t = Math.min(this.flyElapsed / this.flyDuration, 1);
            const interpolated = new Vec3().lerp(this.startPosition, this.targetPosition, t);
    
            if (!window.bblock || !window.boundsMeshInstance || isPointInsideMesh(interpolated, window.boundsMeshInstance)) {
                this.position.copy(interpolated);
            }
            
            const horizontalDist = Math.hypot(
                this.targetPosition.x - this.position.x,
                this.targetPosition.z - this.position.z
            );
            
            if (t >= 1 || horizontalDist < 2) {
                this.targetPosition = null;
                this.startPosition = null;
            }

        } 
        
        if (input) {
            this.move(input);
        }
    
        this.smooth(dt);
    }
    
    move(input) {
        const { position, rotation, moveSpeed, rotateSpeed } = this;
        

        // Get direction vectors
        rotation.transformVector(Vec3.FORWARD, forward);
        rotation.transformVector(Vec3.RIGHT, right);
        rotation.transformVector(Vec3.UP, up);

        // Build movement vector

        if(this.targetPosition===null){

            const moveVec = new Vec3();

            if (input.pinchActive) {
                // If pinching: treat x/y as pan, z as zoom
                v.copy(right).mulScalar(-input.move.value[0] * moveSpeed); moveVec.add(v);
                v.copy(up).mulScalar(input.move.value[1] * moveSpeed); moveVec.add(v);
                v.copy(forward).mulScalar(-input.move.value[2] * moveSpeed); moveVec.add(v);
            } else {
                // Default: joystick / mouse / keyboard movement
                v.copy(right).mulScalar(input.move.value[0] * moveSpeed); moveVec.add(v);
                v.copy(forward).mulScalar(-input.move.value[1] * moveSpeed); moveVec.add(v);
                v.copy(up).mulScalar(-input.move.value[2] * moveSpeed); moveVec.add(v);
            }

            const basePos = position.clone();
            const desiredPos = basePos.clone().add(moveVec);

            const withinBounds = (vec) => isPointInsideMesh(vec, window.boundsMeshInstance);

            if (!window.bblock || !window.boundsMeshInstance || withinBounds(desiredPos)) {
                position.copy(desiredPos);
            } else {
                // Try sliding logic
                const slideXZ = moveVec.clone().set(moveVec.x, 0, moveVec.z);
                const slideXZPos = basePos.clone().add(slideXZ);
                if (withinBounds(slideXZPos)) {
                    position.copy(slideXZPos);
                } else {
                    const slideX = moveVec.clone().set(moveVec.x, 0, 0);
                    const slideZ = moveVec.clone().set(0, 0, moveVec.z);
                    const posX = basePos.clone().add(slideX);
                    const posZ = basePos.clone().add(slideZ);
                    if (withinBounds(posX)) position.copy(posX);
                    else if (withinBounds(posZ)) position.copy(posZ);
                }
            }
        }

        // Rotation only if not pinching
        if (!input.pinchActive) {
            q.setFromAxisAngle(right, (input.isTouch?1:-1)* input.rotate.value[1] * rotateSpeed);
            rotation.mul2(q, rotation);

            q.setFromAxisAngle(Vec3.UP, (input.isTouch?1:-1)* input.rotate.value[0] * rotateSpeed);
            rotation.mul2(q, rotation);

            q.setFromAxisAngle(forward, -input.rotate.value[2] * rotateSpeed);
            rotation.mul(q, rotation);

            rotation.normalize();
        }
    }

    smooth(dt) {
        const weight = damp(0.98, dt);
        this.smoothPosition.lerp(this.smoothPosition, this.position, weight);
        this.smoothRotation.lerp(this.smoothRotation, this.rotation, weight);
    }

    getPose(pose) {
        const { smoothPosition, smoothRotation, distance } = this;
        pose.position.copy(smoothPosition);
        pose.rotation.copy(smoothRotation);
        pose.distance = distance;
    }
}

export { FlyCamera };
