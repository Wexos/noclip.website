
import * as GX from "../gx/gx_enum";
import { PacketParams, MaterialParams, GXMaterialHelperGfx, ColorKind, SceneParams, ub_SceneParamsBufferSize, fillSceneParamsData } from "../gx/gx_render";

import { LiveActor } from "./LiveActor";
import { SceneObjHolder, SceneObj, SpecialTextureType } from "./Main";
import { GravityInfo, GravityTypeMask } from './Gravity';
import { connectToScene, isValidDraw, calcGravityVectorOrZero, calcGravityVector, getJointMtxByName, makeMtxUpNoSupport, makeMtxUpNoSupportPos } from "./ActorUtil";
import { NameObj, MovementType, CalcAnimType, DrawBufferType, DrawType, GameBits } from "./NameObj";
import { vec3, mat4, ReadonlyVec3, ReadonlyMat4 } from "gl-matrix";
import { HitSensor } from "./HitSensor";
import { getMatrixTranslation, transformVec3Mat4w1, computeModelMatrixS, setMatrixTranslation, computeProjectionMatrixFromCuboid, computeMatrixWithoutTranslation, transformVec3Mat4w0, getMatrixAxis, setMatrixAxis, scaleMatrix, Vec3Zero, getMatrixAxisY, MathConstants } from "../MathHelpers";
import { getFirstPolyOnLineCategory, Triangle, CollisionKeeperCategory, CollisionPartsFilterFunc } from "./Collision";
import { JMapInfoIter, getJMapInfoBool, createCsvParser } from "./JMapInfo";
import { assertExists, fallback, assert } from "../util";
import { GfxRenderInstManager, GfxRenderInst } from "../gfx/render/GfxRenderer";
import { ViewerRenderInput } from "../viewer";
import { J3DModelData } from "../Common/JSYSTEM/J3D/J3DGraphBase";
import { Shape } from "../Common/JSYSTEM/J3D/J3DLoader";
import { GXMaterialBuilder } from "../gx/GXMaterialBuilder";
import { TSDraw, TDDraw } from "./DDraw";
import { GX_Program } from "../gx/gx_material";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { colorFromRGBA } from "../Color";
import { TextureMapping } from "../TextureHolder";
import { GfxDevice } from "../gfx/platform/GfxPlatform";

function calcDropShadowVectorOrZero(sceneObjHolder: SceneObjHolder, nameObj: NameObj, pos: ReadonlyVec3, dst: vec3, gravityInfo: GravityInfo | null = null, attachmentFilter: any | null = null): boolean {
    return calcGravityVectorOrZero(sceneObjHolder, nameObj, pos, GravityTypeMask.Shadow, dst, gravityInfo, attachmentFilter);
}

function calcCameraDistanceZ(sceneObjHolder: SceneObjHolder, pos: vec3, scratch = scratchVec3b): number {
    getMatrixTranslation(scratch, sceneObjHolder.viewerInput.camera.worldMatrix);
    return vec3.distance(scratch, pos);
}

const enum DropType { Normal, Surface }
const enum CalcCollisionMode { Off, On, OneTime }
const enum CalcDropGravityMode { Off, On, OneTime, PrivateOff, PrivateOn, PrivateOneTime }

const scratchVec3a = vec3.create();
const scratchVec3b = vec3.create();
const scratchMat4a = mat4.create();
const scratchMat4b = mat4.create();
const scratchTriangle = new Triangle();
class ShadowController {
    public shadowDrawer: ShadowDrawer;
    public isProjected = false;
    public calcRequested = false;
    public groupName: string | null = null;
    public followHostScale = false;
    public visibleSyncHost = true;
    public partsFilter: CollisionPartsFilterFunc | null = null;

    private farClipping = false;
    private valid = true;
    private triHitSensor: HitSensor | null = null;
    private calcCollisionMode = CalcCollisionMode.On;
    private calcCollisionTimer = 0;
    private calcDropGravityMode = CalcDropGravityMode.Off;

    private dropPosMtxRef: mat4 | null = null;
    private dropPosRef: ReadonlyVec3 | null = null;
    private dropPosFix = vec3.create();
    private dropDirRef: ReadonlyVec3 | null = null;
    private dropDirFix = vec3.fromValues(0.0, -1.0, 0.0);
    private dropStartOffset = 50.0;
    private dropLength = 0.0;
    private dropType = DropType.Normal;

    private projectionPosPtr: ReadonlyVec3 | null = null;
    private projectionPosFix = vec3.create();
    private projectionNrmPtr: ReadonlyVec3 | null = null;
    private projectionNrmFix = vec3.fromValues(0.0, 1.0, 0.0);

    constructor(sceneObjHolder: SceneObjHolder, public host: LiveActor, public name: string) {
        sceneObjHolder.create(SceneObj.ShadowControllerHolder);
        sceneObjHolder.shadowControllerHolder!.shadowControllers.push(this);
    }

    public getDropPos(dst: vec3): void {
        if (this.dropPosRef !== null)
            vec3.copy(dst, this.dropPosRef);
        else if (this.dropPosMtxRef !== null)
            transformVec3Mat4w1(dst, this.dropPosMtxRef, this.dropPosFix);
        else
            vec3.copy(dst, this.dropPosFix);
    }

    public getDropDir(): ReadonlyVec3 {
        return this.dropDirRef !== null ? this.dropDirRef : this.dropDirFix;
    }

    public getDropLength(): number {
        return this.dropLength;
    }

    public getProjectionPos(): ReadonlyVec3 {
        return this.projectionPosPtr !== null ? this.projectionPosPtr : this.projectionPosFix;
    }

    public getProjectionNormal(): ReadonlyVec3 {
        return this.projectionNrmPtr !== null ? this.projectionNrmPtr : this.projectionNrmFix;
    }

    public getProjectionLength(): number {
        if (!this.isProjected)
            return -1.0;

        this.getDropPos(scratchVec3a);
        const dir = this.getDropDir();

        vec3.sub(scratchVec3b, this.projectionPosFix, scratchVec3a);
        if (vec3.dot(scratchVec3b, dir) > 0.0)
            return vec3.dist(scratchVec3a, this.projectionPosFix);
        else
            return 0.0;
    }

    public setDropPosMtxPtr(mtx: mat4 | null, offs: vec3): void {
        this.dropPosMtxRef = mtx;
        vec3.copy(this.dropPosFix, offs);
    }

    public getDropPosMtxPtr(): mat4 | null {
        return this.dropPosMtxRef;
    }

    public setDropPosFix(v: ReadonlyVec3): void {
        vec3.copy(this.dropPosFix, v);
    }

    public setDropPosPtr(v: ReadonlyVec3): void {
        this.dropPosRef = v;
    }

    public setDropDirPtr(v: ReadonlyVec3): void {
        this.dropDirRef = v;
    }

    public setDropStartOffset(v: number): void {
        this.dropStartOffset = v;
    }

    public setDropLength(v: number): void {
        this.dropLength = v;
    }

    public setDropTypeNormal(): void {
        this.dropType = DropType.Normal;
    }

    public setDropTypeSurface(): void {
        this.dropType = DropType.Surface;
    }

    public setProjectionFix(pos: vec3, nrm: vec3, isProjected: boolean): void {
        vec3.copy(this.projectionPosFix, pos);
        vec3.copy(this.projectionNrmFix, nrm);
        this.isProjected = isProjected;
        this.triHitSensor = null;
    }

    public setCalcCollisionMode(mode: CalcCollisionMode): void {
        this.calcCollisionMode = mode;

        if (this.calcCollisionMode === CalcCollisionMode.OneTime)
            this.calcCollisionTimer = 0;
    }

    public setCalcDropGravityMode(mode: CalcDropGravityMode): void {
        this.calcDropGravityMode = mode;

        if (this.calcDropGravityMode !== CalcDropGravityMode.Off && this.calcDropGravityMode !== CalcDropGravityMode.PrivateOff) {
            this.dropDirRef = null;
            vec3.set(this.dropDirFix, 0.0, 1.0, 0.0);
        }
    }

    public validate(): void {
        this.valid = true;
    }

    public invalidate(): void {
        this.valid = false;
    }

    public isDraw(): boolean {
        if (this.farClipping)
            return false;

        if (!this.valid)
            return false;

        if (this.visibleSyncHost)
            return isValidDraw(this.host);

        return true;
    }

    public update(sceneObjHolder: SceneObjHolder): void {
        if (this.isDraw()) {
            this.updateDirection(sceneObjHolder);
            this.updateProjection(sceneObjHolder);
        }
    }

    private isCalcGravity(): boolean {
        if (this.calcDropGravityMode === CalcDropGravityMode.Off || this.calcDropGravityMode === CalcDropGravityMode.PrivateOff)
            return false;

        // XXX(jstpierre): It doesn't seem to check OneTime? Bug in the original game?
        // if (this.calcDropGravityMode === CalcDropGravityMode.On || this.calcDropGravityMode === CalcDropGravityMode.PrivateOn)
        //     return true;

        return true;
    }

    private isCalcShadowGravity(): boolean {
        return this.calcDropGravityMode === CalcDropGravityMode.PrivateOn || this.calcDropGravityMode === CalcDropGravityMode.PrivateOneTime;
    }

    public updateDirection(sceneObjHolder: SceneObjHolder): void {
        if (!this.isCalcGravity())
            return;

        this.getDropPos(scratchVec3a);

        let foundPrivateGravity = false;
        if (this.isCalcShadowGravity())
            foundPrivateGravity = calcDropShadowVectorOrZero(sceneObjHolder, this.host, scratchVec3a, this.dropDirFix);

        if (!foundPrivateGravity)
            calcGravityVector(sceneObjHolder, this.host, scratchVec3a, this.dropDirFix);
    }

    private isCalcCollision(): boolean {
        if (this.calcCollisionMode === CalcCollisionMode.Off)
            return false;
        else if (this.calcCollisionMode === CalcCollisionMode.On)
            return true;
        else if (this.calcCollisionMode === CalcCollisionMode.OneTime)
            return (this.calcCollisionTimer === 0);
        else
            throw "whoops";
    }

    public updateProjection(sceneObjHolder: SceneObjHolder): void {
        if (!this.isCalcCollision())
            return;

        this.getDropPos(scratchVec3a);
        const dropDir = this.getDropDir();
        vec3.scaleAndAdd(scratchVec3a, scratchVec3a, dropDir, -this.dropStartOffset);
        vec3.scale(scratchVec3b, dropDir, this.dropLength + this.dropStartOffset);

        const category: CollisionKeeperCategory = this.dropType === DropType.Surface ? CollisionKeeperCategory.WaterSurface : CollisionKeeperCategory.Map;
        this.isProjected = getFirstPolyOnLineCategory(sceneObjHolder, this.projectionPosFix, scratchTriangle, scratchVec3a, scratchVec3b, null, this.partsFilter, category);

        if (this.isProjected) {
            vec3.copy(this.projectionNrmFix, scratchTriangle.faceNormal);
            this.triHitSensor = scratchTriangle.hitSensor;
        } else {
            this.triHitSensor = null;
        }

        if (this.calcCollisionMode === CalcCollisionMode.OneTime)
            this.calcCollisionTimer++;
    }

    public updateFarClipping(sceneObjHolder: SceneObjHolder, threshold: number): void {
        this.getDropPos(scratchVec3a);
        const distance = calcCameraDistanceZ(sceneObjHolder, scratchVec3a);
        this.farClipping = distance > threshold;
    }

    public requestCalc(): void {
        this.calcRequested = true;
    }
}

abstract class ShadowDrawer extends NameObj {
    constructor(sceneObjHolder: SceneObjHolder, name: string, public controller: ShadowController) {
        super(sceneObjHolder, name);
    }
}

const materialParams = new MaterialParams();
const packetParams = new PacketParams();

abstract class ShadowSurfaceDrawer extends ShadowDrawer {
    protected material: GXMaterialHelperGfx;

    constructor(sceneObjHolder: SceneObjHolder, name: string, controller: ShadowController) {
        super(sceneObjHolder, name, controller);

        connectToScene(sceneObjHolder, this, MovementType.None, CalcAnimType.None, DrawBufferType.None, DrawType.ShadowVolume);

        const mb = new GXMaterialBuilder();
        mb.setTevOrder(0, GX.TexCoordID.TEXCOORD_NULL, GX.TexMapID.TEXMAP_NULL, GX.RasColorChannelID.COLOR_ZERO);
        mb.setTevColorIn(0, GX.CC.C0, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO);
        mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setTevAlphaIn(0, GX.CA.A0, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO);
        mb.setTevAlphaOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setCullMode(GX.CullMode.BACK);
        mb.setZMode(true, GX.CompareType.LEQUAL, false);
        mb.setAlphaCompare(GX.CompareType.ALWAYS, 0, GX.AlphaOp.OR, GX.CompareType.ALWAYS, 0);
        mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.SRCALPHA, GX.BlendFactor.INVSRCALPHA);
        mb.setUsePnMtxIdx(false);
        mb.setColorUpdate(false);
        mb.setAlphaUpdate(true);

        this.material = new GXMaterialHelperGfx(mb.finish('ShadowVolumeDrawer Front'));
    }
}

function drawCircle(ddraw: TDDraw, pos: ReadonlyVec3, axis: ReadonlyVec3, radius: number, pointCount: number): void {
    mat4.identity(scratchMat4a);
    mat4.rotate(scratchMat4a, scratchMat4a, MathConstants.TAU / pointCount, axis);

    if (axis[0] === 0.0)
        vec3.set(scratchVec3a, 0.0, -axis[2], axis[1]);
    else
        vec3.set(scratchVec3a, axis[1], -axis[0], 0.0);

    ddraw.begin(GX.Command.DRAW_TRIANGLE_FAN);
    ddraw.position3vec3(pos);
    for (let i = 0; i < pointCount; i++) {
        vec3.scaleAndAdd(scratchVec3b, pos, scratchVec3a, radius);
        transformVec3Mat4w0(scratchVec3b, scratchMat4a, scratchVec3b);
        ddraw.position3vec3(scratchVec3b);
    }
    ddraw.end();
}

class ShadowSurfaceCircle extends ShadowSurfaceDrawer {
    // TODO(jstpierre): TSDraw and a matrix if we ever find a place this is used.
    private ddraw: TDDraw = new TDDraw();
    public radius: number = 100.0;

    constructor(sceneObjHolder: SceneObjHolder, controller: ShadowController) {
        super(sceneObjHolder, 'ShadowSurfaceCircle', controller);
        debugger;

        this.ddraw.setVtxDesc(GX.Attr.POS, true);
        this.ddraw.setVtxAttrFmt(GX.VtxFmt.VTXFMT0, GX.Attr.POS, GX.CompCnt.POS_XYZ);
    }

    public draw(sceneObjHolder: SceneObjHolder, renderInstManager: GfxRenderInstManager, viewerInput: ViewerRenderInput): void {
        if (!this.controller.isProjected || !this.controller.isDraw())
            return;

        super.draw(sceneObjHolder, renderInstManager, viewerInput);

        const template = renderInstManager.pushTemplateRenderInst();
        materialParams.u_Color[ColorKind.C0].a = 0x80 / 0xFF;
        this.material.allocateMaterialParamsDataOnInst(template, materialParams);

        mat4.copy(packetParams.u_PosMtx[0], viewerInput.camera.viewMatrix);
        this.material.allocatePacketParamsDataOnInst(template, packetParams);

        this.ddraw.beginDraw();
        vec3.negate(scratchVec3a, this.controller.getProjectionNormal());
        drawCircle(this.ddraw, this.controller.getProjectionPos(), scratchVec3a, this.radius, 20);
        this.ddraw.endAndUpload(sceneObjHolder.modelCache.device, renderInstManager);
        renderInstManager.popTemplateRenderInst();
    }

    public destroy(device: GfxDevice): void {
        this.ddraw.destroy(device);
    }
}

abstract class ShadowVolumeDrawer extends ShadowDrawer {
    public startDrawShapeOffset: number = 0.0;
    public endDrawShapeOffset: number = 0.0;
    public cutDropShadow: boolean = false;

    protected materialBack: GXMaterialHelperGfx;
    protected materialFront: GXMaterialHelperGfx;

    constructor(sceneObjHolder: SceneObjHolder, name: string, controller: ShadowController) {
        super(sceneObjHolder, name, controller);

        connectToScene(sceneObjHolder, this, MovementType.None, CalcAnimType.None, DrawBufferType.None, DrawType.ShadowVolume);

        // TODO(jstpierre): Move to ShadowVolumeDrawInit?
        this.setupMaterial(false);
    }

    protected setupMaterial(usePnMtxIdx: boolean): void {
        const mb = new GXMaterialBuilder();
        mb.setTevOrder(0, GX.TexCoordID.TEXCOORD_NULL, GX.TexMapID.TEXMAP_NULL, GX.RasColorChannelID.COLOR0A0);
        mb.setTevColorIn(0, GX.CC.C0, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO);
        mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setTevAlphaIn(0, GX.CA.A0, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO);
        mb.setTevAlphaOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setAlphaCompare(GX.CompareType.ALWAYS, 0, GX.AlphaOp.OR, GX.CompareType.ALWAYS, 0);
        mb.setZMode(true, GX.CompareType.GEQUAL, false);
        mb.setUsePnMtxIdx(usePnMtxIdx);
        mb.setColorUpdate(false);
        mb.setAlphaUpdate(true);

        mb.setCullMode(GX.CullMode.FRONT);
        mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.ONE, GX.BlendFactor.ONE);
        this.materialFront = new GXMaterialHelperGfx(mb.finish('ShadowVolumeDrawer Front'));
        mb.setCullMode(GX.CullMode.BACK);
        mb.setBlendMode(GX.BlendMode.SUBTRACT, GX.BlendFactor.ZERO, GX.BlendFactor.ZERO);
        this.materialBack = new GXMaterialHelperGfx(mb.finish('ShadowVolumeDrawer Back'));

        assert(this.materialBack.materialParamsBufferSize === this.materialFront.materialParamsBufferSize);
        assert(this.materialBack.packetParamsBufferSize === this.materialFront.packetParamsBufferSize);
    }

    protected abstract isDraw(): boolean;
    protected abstract loadDrawModelMtx(packetParams: PacketParams, viewerInput: ViewerRenderInput): void;
    protected abstract drawShapes(sceneObjHolder: SceneObjHolder, renderInstManager: GfxRenderInstManager): void;

    public draw(sceneObjHolder: SceneObjHolder, renderInstManager: GfxRenderInstManager, viewerInput: ViewerRenderInput): void {
        if (!this.isDraw())
            return;

        super.draw(sceneObjHolder, renderInstManager, viewerInput);

        const template = renderInstManager.pushTemplateRenderInst();
        materialParams.u_Color[ColorKind.C0].a = 0x40 / 0xFF;
        this.materialFront.allocateMaterialParamsDataOnInst(template, materialParams);

        this.loadDrawModelMtx(packetParams, viewerInput);
        this.materialFront.allocatePacketParamsDataOnInst(template, packetParams);

        this.drawShapes(sceneObjHolder, renderInstManager);
        renderInstManager.popTemplateRenderInst();
    }

    protected calcBaseDropLength(controller: ShadowController = this.controller): number {
        let length: number;
        if (this.cutDropShadow && controller.isProjected)
            length = controller.getProjectionLength();
        else
            length = controller.getDropLength();
        return length - this.startDrawShapeOffset + this.endDrawShapeOffset;
    }

    protected calcBaseDropPosition(dst: vec3, controller: ShadowController = this.controller): void {
        controller.getDropPos(scratchVec3a);
        const dir = controller.getDropDir();
        vec3.scaleAndAdd(dst, scratchVec3a, dir, this.startDrawShapeOffset);
    }
}

abstract class ShadowVolumeModel extends ShadowVolumeDrawer {
    public modelData: J3DModelData | null = null;

    public initVolumeModel(sceneObjHolder: SceneObjHolder, filename: string): void {
        const resourceHolder = sceneObjHolder.modelCache.getResourceHolder(filename);
        this.modelData = resourceHolder.getModel(filename);
    }

    protected isDraw(): boolean {
        return this.controller.isProjected && this.controller.isDraw();
    }

    protected drawShapes(sceneObjHolder: SceneObjHolder, renderInstManager: GfxRenderInstManager): void {
        const shapeData = this.modelData!.shapeData;

        for (let i = 0; i < shapeData.length; i++) {
            const template = renderInstManager.pushTemplateRenderInst();

            assert(shapeData[i].draws.length === 1);
            shapeData[i].shapeHelper.setOnRenderInst(template, shapeData[i].draws[0]);

            const front = renderInstManager.newRenderInst();
            this.materialFront.setOnRenderInst(sceneObjHolder.modelCache.device, renderInstManager.gfxRenderCache, front);
            renderInstManager.submitRenderInst(front);

            const back = renderInstManager.newRenderInst();
            this.materialBack.setOnRenderInst(sceneObjHolder.modelCache.device, renderInstManager.gfxRenderCache, back);
            renderInstManager.submitRenderInst(back);

            renderInstManager.popTemplateRenderInst();
        }
    }
}

class ShadowVolumeSphere extends ShadowVolumeModel {
    public radius = 0.0;

    constructor(sceneObjHolder: SceneObjHolder, controller: ShadowController) {
        super(sceneObjHolder, 'ShadowVolumeSphere', controller);
        this.initVolumeModel(sceneObjHolder, 'ShadowVolumeSphere');
    }

    public loadDrawModelMtx(packetParams: PacketParams, viewerInput: ViewerRenderInput): void {
        let scale = this.radius / 100.0;
        if (this.controller.followHostScale)
            scale *= this.controller.host.scale[0];

        computeModelMatrixS(packetParams.u_PosMtx[0], scale);
        const projectionPos = this.controller.getProjectionPos();
        setMatrixTranslation(packetParams.u_PosMtx[0], projectionPos);

        mat4.mul(packetParams.u_PosMtx[0], viewerInput.camera.viewMatrix, packetParams.u_PosMtx[0]);
    }

    public static requestArchives(sceneObjHolder: SceneObjHolder): void {
        sceneObjHolder.modelCache.requestObjectData('ShadowVolumeSphere');
    }
}

class ShadowVolumeOval extends ShadowVolumeModel {
    public size = vec3.fromValues(100.0, 100.0, 200.0);

    constructor(sceneObjHolder: SceneObjHolder, controller: ShadowController) {
        super(sceneObjHolder, 'ShadowVolumeOval', controller);
        this.initVolumeModel(sceneObjHolder, 'ShadowVolumeSphere');
    }

    public loadDrawModelMtx(packetParams: PacketParams, viewerInput: ViewerRenderInput): void {
        vec3.scale(scratchVec3a, this.size, 1 / 100.0);
        scratchVec3a[0] = Math.max(scratchVec3a[0], 0.01);
        scratchVec3a[1] = Math.max(scratchVec3a[1], 0.01);
        scratchVec3a[2] = Math.max(scratchVec3a[2], 0.01);

        if (this.controller.followHostScale)
            vec3.mul(scratchVec3a, scratchVec3a, this.controller.host.scale);

        computeMatrixWithoutTranslation(scratchMat4a, this.controller.getDropPosMtxPtr()!);
        mat4.scale(scratchMat4a, scratchMat4a, scratchVec3a);
        mat4.invert(scratchMat4b, scratchMat4a);
        transformVec3Mat4w0(scratchVec3a, scratchMat4b, this.controller.getDropDir());
        makeMtxUpNoSupport(scratchMat4b, scratchVec3a);
        mat4.mul(scratchMat4a, scratchMat4a, scratchMat4b);

        const projectionPos = this.controller.getProjectionPos();
        setMatrixTranslation(scratchMat4a, projectionPos);

        getMatrixAxis(null, scratchVec3b, null, scratchMat4a);
        vec3.normalize(scratchVec3b, scratchVec3b);

        getMatrixAxis(scratchVec3a, null, null, scratchMat4a);
        vec3.scaleAndAdd(scratchVec3a, scratchVec3a, scratchVec3b, -vec3.dot(scratchVec3a, scratchVec3b));
        setMatrixAxis(scratchMat4a, scratchVec3a, null, null);

        getMatrixAxis(null, null, scratchVec3a, scratchMat4a);
        vec3.scaleAndAdd(scratchVec3a, scratchVec3a, scratchVec3b, -vec3.dot(scratchVec3a, scratchVec3b));
        setMatrixAxis(scratchMat4a, null, null, scratchVec3a);

        mat4.mul(packetParams.u_PosMtx[0], viewerInput.camera.viewMatrix, scratchMat4a);
    }

    public static requestArchives(sceneObjHolder: SceneObjHolder): void {
        sceneObjHolder.modelCache.requestObjectData('ShadowVolumeSphere');
    }
}

class ShadowVolumeCylinder extends ShadowVolumeModel {
    public radius: number = 100.0;

    constructor(sceneObjHolder: SceneObjHolder, controller: ShadowController) {
        super(sceneObjHolder, 'ShadowVolumeCylinder', controller);
        this.initVolumeModel(sceneObjHolder, 'ShadowVolumeCylinder');
    }

    public loadDrawModelMtx(packetParams: PacketParams, viewerInput: ViewerRenderInput): void {
        this.calcBaseDropPosition(scratchVec3a);
        vec3.negate(scratchVec3b, this.controller.getDropDir());

        makeMtxUpNoSupportPos(scratchMat4a, scratchVec3b, scratchVec3a);
        transformVec3Mat4w0(scratchVec3a, scratchMat4a, Vec3Zero);

        let scaleXZ = this.radius / 100.0;
        if (this.controller.followHostScale)
            scaleXZ *= this.controller.host.scale[0];
        const scaleY = this.calcBaseDropLength();

        scaleMatrix(scratchMat4a, scratchMat4a, scaleXZ, scaleY, scaleXZ);
        mat4.mul(packetParams.u_PosMtx[0], viewerInput.camera.viewMatrix, scratchMat4a);
    }

    public static requestArchives(sceneObjHolder: SceneObjHolder): void {
        sceneObjHolder.modelCache.requestObjectData('ShadowVolumeCylinder');
    }
}

function findPosNrmMtxIndexFromShape(shape: Shape, jointIndex: number): number | null {
    for (let i = 0; i < shape.mtxGroups.length; i++) {
        const mtxGroup = shape.mtxGroups[i];
        for (let j = 0; j < mtxGroup.useMtxTable.length; j++) {
            if (mtxGroup.useMtxTable[j] === jointIndex)
                return j;
        }
    }
    return null;
}

function findPosNrmMtxIndexFromModel(modelData: J3DModelData, jointIndex: number): number {
    for (let i = 0; i < modelData.shapeData.length; i++) {
        const shape = modelData.shapeData[i].shape;
        const posNrmMtxIndex = findPosNrmMtxIndexFromShape(shape, jointIndex);
        if (posNrmMtxIndex !== null)
            return posNrmMtxIndex;
    }

    throw "whoops";
}

class ShadowVolumeFlatModel extends ShadowVolumeModel {
    private baseMtxPtr: ReadonlyMat4;
    private rootJointPosNrmMtxIndex: number;
    private dropJointPosNrmMtxIndex: number;

    constructor(sceneObjHolder: SceneObjHolder, controller: ShadowController, modelName: string) {
        super(sceneObjHolder, 'ShadowVolumeCylinder', controller);
        this.initVolumeModel(sceneObjHolder, modelName);

        const rootJoint = this.modelData!.rootJointTreeNode.children[0];
        const dropJoint = rootJoint.children[0];
        this.rootJointPosNrmMtxIndex = findPosNrmMtxIndexFromModel(this.modelData!, rootJoint.jointIndex);
        this.dropJointPosNrmMtxIndex = findPosNrmMtxIndexFromModel(this.modelData!, dropJoint.jointIndex);

        this.setupMaterial(true);
    }

    public setBaseMtxPtr(m: ReadonlyMat4): void {
        this.baseMtxPtr = m;
    }

    private calcRootJoint(dst: mat4, dropDir: ReadonlyVec3): void {
        mat4.copy(dst, this.baseMtxPtr);
        getMatrixAxisY(scratchVec3b, this.baseMtxPtr);
        if (vec3.dot(scratchVec3b, dropDir) >= 0.0)
            mat4.translate(dst, dst, dropDir);
    }

    private calcDropJoint(dst: mat4, dropDir: ReadonlyVec3): void {
        mat4.copy(dst, this.baseMtxPtr);
        getMatrixAxisY(scratchVec3b, this.baseMtxPtr);
        if (vec3.dot(scratchVec3b, dropDir) < 0.0) {
            dst[12] += dropDir[0];
            dst[13] += dropDir[1];
            dst[14] += dropDir[2];
        }
    }

    public loadDrawModelMtx(packetParams: PacketParams, viewerInput: ViewerRenderInput): void {
        vec3.scale(scratchVec3a, this.controller.getDropDir(), this.calcBaseDropLength());

        const rootMtx = packetParams.u_PosMtx[this.rootJointPosNrmMtxIndex];
        const dropMtx = packetParams.u_PosMtx[this.dropJointPosNrmMtxIndex];

        this.calcRootJoint(rootMtx, scratchVec3a);
        if (this.controller.followHostScale)
            mat4.scale(rootMtx, rootMtx, this.controller.host.scale);
        mat4.mul(rootMtx, viewerInput.camera.viewMatrix, rootMtx);

        this.calcDropJoint(dropMtx, scratchVec3a);
        if (this.controller.followHostScale)
            mat4.scale(dropMtx, dropMtx, this.controller.host.scale);
        mat4.mul(dropMtx, viewerInput.camera.viewMatrix, dropMtx);
    }
}

// TODO(jstpierre): This is not how it's normally done. fillSilhouetteColor is called directly from the main list, normally.
class AlphaShadow extends NameObj {
    private materialHelperDrawAlpha: GXMaterialHelperGfx;
    private orthoSceneParams = new SceneParams();
    private orthoQuad = new TSDraw();
    private textureMapping = new TextureMapping();

    constructor(sceneObjHolder: SceneObjHolder) {
        super(sceneObjHolder, 'AlphaShadow');

        const device = sceneObjHolder.modelCache.device, cache = sceneObjHolder.modelCache.cache;

        connectToScene(sceneObjHolder, this, MovementType.None, CalcAnimType.None, DrawBufferType.None, DrawType.AlphaShadow);

        const mb = new GXMaterialBuilder(`fillSilhouetteColor`);
        mb.setTexCoordGen(GX.TexCoordID.TEXCOORD0, GX.TexGenType.MTX2x4, GX.TexGenSrc.TEX0, GX.TexGenMatrix.IDENTITY);
        mb.setTevOrder(0, GX.TexCoordID.TEXCOORD0, GX.TexMapID.TEXMAP0, GX.RasColorChannelID.COLOR_ZERO);
        mb.setTevColorIn(0, GX.CC.C0, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO);
        mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setTevKAlphaSel(0, GX.KonstAlphaSel.KASEL_K0_A);
        mb.setTevAlphaIn(0, GX.CA.TEXA, GX.CA.KONST, GX.CA.A0, GX.CA.ZERO);
        mb.setTevAlphaOp(0, GX.TevOp.COMP_RGB8_GT, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setZMode(true, GX.CompareType.ALWAYS, false);
        mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.SRCALPHA, GX.BlendFactor.INVSRCALPHA);
        mb.setAlphaCompare(GX.CompareType.ALWAYS, 0, GX.AlphaOp.OR, GX.CompareType.ALWAYS, 0);
        mb.setUsePnMtxIdx(false);
        this.materialHelperDrawAlpha = new GXMaterialHelperGfx(mb.finish());

        computeProjectionMatrixFromCuboid(this.orthoSceneParams.u_Projection, 0, 1, 0, 1, 0, 10);

        this.orthoQuad.setVtxDesc(GX.Attr.POS, true);
        this.orthoQuad.setVtxDesc(GX.Attr.TEX0, true);
        this.orthoQuad.setVtxAttrFmt(GX.VtxFmt.VTXFMT0, GX.Attr.POS, GX.CompCnt.POS_XYZ);
        this.orthoQuad.setVtxAttrFmt(GX.VtxFmt.VTXFMT0, GX.Attr.TEX0, GX.CompCnt.TEX_ST);

        this.orthoQuad.beginDraw();
        this.orthoQuad.begin(GX.Command.DRAW_QUADS, 4);
        this.orthoQuad.position3f32(0, 0, 0);
        this.orthoQuad.texCoord2f32(GX.Attr.TEX0, 0, 0);
        this.orthoQuad.position3f32(1, 0, 0);
        this.orthoQuad.texCoord2f32(GX.Attr.TEX0, 1, 0);
        this.orthoQuad.position3f32(1, 1, 0);
        this.orthoQuad.texCoord2f32(GX.Attr.TEX0, 1, 1);
        this.orthoQuad.position3f32(0, 1, 0);
        this.orthoQuad.texCoord2f32(GX.Attr.TEX0, 0, 1);
        this.orthoQuad.end();
        this.orthoQuad.endDraw(device, cache);

        sceneObjHolder.specialTextureBinder.registerTextureMapping(this.textureMapping, SpecialTextureType.OpaqueSceneTexture);
    }

    public draw(sceneObjHolder: SceneObjHolder, renderInstManager: GfxRenderInstManager, viewerInput: ViewerRenderInput): void {
        super.draw(sceneObjHolder, renderInstManager, viewerInput);

        colorFromRGBA(materialParams.u_Color[ColorKind.K0], 0.0, 0.0, 0.0, 1 / 0xFF);
        colorFromRGBA(materialParams.u_Color[ColorKind.C0], 0.0, 0.0, 0.0, 0.5);
        materialParams.m_TextureMapping[0].copy(this.textureMapping);

        // Blend onto main screen.
        const renderInst = renderInstManager.newRenderInst();
        const sceneParamsOffs = renderInst.allocateUniformBuffer(GX_Program.ub_SceneParams, ub_SceneParamsBufferSize);
        fillSceneParamsData(renderInst.mapUniformBufferF32(GX_Program.ub_SceneParams), sceneParamsOffs, this.orthoSceneParams);
        this.materialHelperDrawAlpha.setOnRenderInst(sceneObjHolder.modelCache.device, renderInstManager.gfxRenderCache, renderInst);
        this.materialHelperDrawAlpha.allocateMaterialParamsDataOnInst(renderInst, materialParams);
        renderInst.setSamplerBindingsFromTextureMappings(materialParams.m_TextureMapping);
        this.orthoQuad.setOnRenderInst(renderInst);
        mat4.identity(packetParams.u_PosMtx[0]);
        this.materialHelperDrawAlpha.allocatePacketParamsDataOnInst(renderInst, packetParams);
        renderInstManager.submitRenderInst(renderInst);
    }
}

export class ShadowControllerHolder extends NameObj {
    public shadowControllers: ShadowController[] = [];
    private alphaShadow: AlphaShadow;

    constructor(sceneObjHolder: SceneObjHolder) {
        super(sceneObjHolder, 'ShadowControllerHolder');

        connectToScene(sceneObjHolder, this, MovementType.ShadowControllerHolder, CalcAnimType.None, DrawBufferType.None, DrawType.None);
        this.alphaShadow = new AlphaShadow(sceneObjHolder);
    }

    public initAfterPlacement(sceneObjHolder: SceneObjHolder): void {
        super.initAfterPlacement(sceneObjHolder);

        for (let i = 0; i < this.shadowControllers.length; i++) {
            const controller = this.shadowControllers[i];
            controller.updateDirection(sceneObjHolder);
            controller.updateProjection(sceneObjHolder);
        }
    }

    public movement(sceneObjHolder: SceneObjHolder, viewerInput: ViewerRenderInput): void {
        super.movement(sceneObjHolder, viewerInput);
        this.updateController(sceneObjHolder);
    }

    private updateController(sceneObjHolder: SceneObjHolder): void {
        for (let i = 0; i < this.shadowControllers.length; i++) {
            const controller = this.shadowControllers[i];
            if (!controller.calcRequested)
                continue;
            controller.update(sceneObjHolder);
        }
    }

    public static requestArchives(sceneObjHolder: SceneObjHolder): void {
        ShadowVolumeSphere.requestArchives(sceneObjHolder);
        ShadowVolumeOval.requestArchives(sceneObjHolder);
        ShadowVolumeCylinder.requestArchives(sceneObjHolder);
    }
}

export class ShadowControllerList {
    public shadowControllers: ShadowController[] = [];

    public addController(controller: ShadowController): void {
        this.shadowControllers.push(controller);
    }

    public getController(name: string | null): ShadowController {
        if (this.shadowControllers.length === 1)
            return this.shadowControllers[0];
        else
            return this.shadowControllers.find((shadow) => shadow.name === name)!;
    }

    public requestCalc(): void {
        for (let i = 0; i < this.shadowControllers.length; i++)
            this.shadowControllers[i].requestCalc();
    }
}

function getJMapInfoV3f(dst: vec3, infoIter: JMapInfoIter, prefix: string): void {
    dst[0] = fallback(infoIter.getValueNumber(`${prefix}X`), 0);
    dst[1] = fallback(infoIter.getValueNumber(`${prefix}Y`), 0);
    dst[2] = fallback(infoIter.getValueNumber(`${prefix}Z`), 0);
}

function setUpShadowControlBaseMtxFromCSV(controller: ShadowController, actor: LiveActor, infoIter: JMapInfoIter): void {
    const jointName = infoIter.getValueString('Joint');

    if (jointName === null || jointName === '::ACTOR_TRANS' || jointName === '::OTHER_TRANS') {
        controller.setDropPosPtr(actor.translation);
    } else if (jointName === '::FIX_POSITION') {
        controller.setDropPosFix(actor.translation);
    } else if (jointName === '::BASE_MATRIX' || jointName === '::OTHER_MATRIX') {
        getJMapInfoV3f(scratchVec3a, infoIter, 'DropOffset');
        controller.setDropPosMtxPtr(actor.getBaseMtx(), scratchVec3a);
    } else {
        const jointMtx = assertExists(getJointMtxByName(actor, jointName));
        getJMapInfoV3f(scratchVec3a, infoIter, 'DropOffset');
        controller.setDropPosMtxPtr(jointMtx, scratchVec3a);
    }
}

function setUpShadowControlFromCSV(controller: ShadowController, actor: LiveActor, infoIter: JMapInfoIter): void {
    controller.setDropLength(fallback(infoIter.getValueNumber('DropLength'), 1000.0));
    controller.setDropStartOffset(fallback(infoIter.getValueNumber('DropStart'), 0.0));
    setUpShadowControlBaseMtxFromCSV(controller, actor, infoIter);
    controller.followHostScale = getJMapInfoBool(fallback(infoIter.getValueNumber('FollowScale'), 1));
    controller.visibleSyncHost = getJMapInfoBool(fallback(infoIter.getValueNumber('SyncShow'), 1));
    controller.setCalcCollisionMode(fallback(infoIter.getValueNumber('Collision'), CalcCollisionMode.Off));
    controller.setCalcDropGravityMode(fallback(infoIter.getValueNumber('Gravity'), CalcDropGravityMode.Off));
}

function createShadowControlFromCSV(sceneObjHolder: SceneObjHolder, actor: LiveActor, infoIter: JMapInfoIter): ShadowController {
    const name = assertExists(infoIter.getValueString('Name'));
    const controller = new ShadowController(sceneObjHolder, actor, name);
    controller.groupName = infoIter.getValueString('GroupName');
    controller.setDropDirPtr(actor.gravityVector);
    setUpShadowControlFromCSV(controller, actor, infoIter);
    actor.shadowControllerList!.addController(controller);
    return controller;
}

function setUpShadowVolumeFromCSV(volume: ShadowVolumeDrawer, infoIter: JMapInfoIter): void {
    volume.startDrawShapeOffset = fallback(infoIter.getValueNumber('VolumeStart'), 100.0);
    volume.endDrawShapeOffset = fallback(infoIter.getValueNumber('VolumeEnd'), 100.0);
    const volumeCut = fallback(infoIter.getValueNumber('VolumeCut'), 0);
    volume.cutDropShadow = volumeCut !== 0;
}

function createShadowSurfaceCircleFromCSV(sceneObjHolder: SceneObjHolder, actor: LiveActor, infoIter: JMapInfoIter): void {
    const controller = createShadowControlFromCSV(sceneObjHolder, actor, infoIter);
    controller.setDropTypeSurface();

    const drawer = new ShadowSurfaceCircle(sceneObjHolder, controller);
    drawer.radius = fallback(infoIter.getValueNumber('Radius'), 100.0);

    controller.shadowDrawer = drawer;
}

function createShadowVolumeSphereFromCSV(sceneObjHolder: SceneObjHolder, actor: LiveActor, infoIter: JMapInfoIter): void {
    const controller = createShadowControlFromCSV(sceneObjHolder, actor, infoIter);
    controller.setDropTypeNormal();

    const drawer = new ShadowVolumeSphere(sceneObjHolder, controller);
    setUpShadowVolumeFromCSV(drawer, infoIter);
    drawer.radius = fallback(infoIter.getValueNumber('Radius'), 100.0);

    controller.shadowDrawer = drawer;
}

function createShadowVolumeOvalFromCSV(sceneObjHolder: SceneObjHolder, actor: LiveActor, infoIter: JMapInfoIter): void {
    const controller = createShadowControlFromCSV(sceneObjHolder, actor, infoIter);
    controller.setDropTypeNormal();

    const drawer = new ShadowVolumeOval(sceneObjHolder, controller);
    setUpShadowVolumeFromCSV(drawer, infoIter);
    vec3.set(drawer.size, 100.0, 100.0, 100.0);
    getJMapInfoV3f(drawer.size, infoIter, `Size`);

    controller.shadowDrawer = drawer;
}

function createShadowVolumeCylinderFromCSV(sceneObjHolder: SceneObjHolder, actor: LiveActor, infoIter: JMapInfoIter): void {
    const controller = createShadowControlFromCSV(sceneObjHolder, actor, infoIter);
    controller.setDropTypeNormal();

    const drawer = new ShadowVolumeCylinder(sceneObjHolder, controller);
    setUpShadowVolumeFromCSV(drawer, infoIter);
    drawer.radius = fallback(infoIter.getValueNumber('Radius'), 100.0);

    controller.shadowDrawer = drawer;
}

function addShadowFromCSV(sceneObjHolder: SceneObjHolder, actor: LiveActor, infoIter: JMapInfoIter): void {
    const shadowType = assertExists(infoIter.getValueString('Type'));
    if (shadowType === 'SurfaceCircle') {
        createShadowSurfaceCircleFromCSV(sceneObjHolder, actor, infoIter);
    } else if (shadowType === 'SurfaceOval') {
    } else if (shadowType === 'SurfaceBox') {
    } else if (shadowType === 'VolumeSphere') {
        createShadowVolumeSphereFromCSV(sceneObjHolder, actor, infoIter);
    } else if (shadowType === 'VolumeOval') {
        createShadowVolumeOvalFromCSV(sceneObjHolder, actor, infoIter);
    } else if (shadowType === 'VolumeOvalPole') {
    } else if (shadowType === 'VolumeCylinder') {
        createShadowVolumeCylinderFromCSV(sceneObjHolder, actor, infoIter);
    } else if (shadowType === 'VolumeBox') {
    } else if (shadowType === 'VolumeFlatModel') {
    } else if (shadowType === 'VolumeLine') {
    } else {
        throw "whoops";
    }
}

export function initShadowFromCSV(sceneObjHolder: SceneObjHolder, actor: LiveActor): void {
    actor.shadowControllerList = new ShadowControllerList();

    let shadowFile: ArrayBufferSlice;

    if (sceneObjHolder.sceneDesc.gameBit === GameBits.SMG1)
        shadowFile = assertExists(actor.resourceHolder.arc.findFileData(`Shadow.bcsv`));
    else if (sceneObjHolder.sceneDesc.gameBit === GameBits.SMG2)
        shadowFile = assertExists(actor.resourceHolder.arc.findFileData(`ActorInfo/Shadow.bcsv`));
    else
        throw "whoops";

    const shadowData = createCsvParser(shadowFile);
    shadowData.mapRecords((infoIter) => {
        addShadowFromCSV(sceneObjHolder, actor, infoIter);
    });
}

function createShadowControllerSurfaceParam(sceneObjHolder: SceneObjHolder, actor: LiveActor, name = 'default'): ShadowController {
    const controller = new ShadowController(sceneObjHolder, actor, name);
    controller.setDropPosPtr(actor.translation);
    controller.setDropDirPtr(actor.gravityVector);
    controller.setDropLength(1000.0);
    controller.setDropTypeSurface();
    actor.shadowControllerList!.addController(controller);
    return controller;
}

export function addShadowSurfaceCircle(sceneObjHolder: SceneObjHolder, actor: LiveActor, name: string, radius: number): void {
    const controller = createShadowControllerSurfaceParam(sceneObjHolder, actor, name);
    const drawer = new ShadowSurfaceCircle(sceneObjHolder, controller);
    drawer.radius = radius;
    controller.shadowDrawer = drawer;
}

function createShadowControllerVolumeParam(sceneObjHolder: SceneObjHolder, actor: LiveActor, name = 'default'): ShadowController {
    const controller = new ShadowController(sceneObjHolder, actor, name);
    controller.setDropPosPtr(actor.translation);
    controller.setDropDirPtr(actor.gravityVector);
    controller.setDropLength(1000.0);
    controller.setDropTypeNormal();
    actor.shadowControllerList!.addController(controller);
    return controller;
}

export function addShadowVolumeSphere(sceneObjHolder: SceneObjHolder, actor: LiveActor, name: string, radius: number): void {
    const controller = createShadowControllerVolumeParam(sceneObjHolder, actor, name);
    const drawer = new ShadowVolumeSphere(sceneObjHolder, controller);
    drawer.radius = radius;
    controller.shadowDrawer = drawer;
}

export function addShadowVolumeCylinder(sceneObjHolder: SceneObjHolder, actor: LiveActor, name: string, radius: number): void {
    const controller = createShadowControllerVolumeParam(sceneObjHolder, actor, name);
    const drawer = new ShadowVolumeCylinder(sceneObjHolder, controller);
    drawer.radius = radius;
    controller.shadowDrawer = drawer;
    controller.setCalcCollisionMode(CalcCollisionMode.Off);
}

export function addShadowVolumeFlatModel(sceneObjHolder: SceneObjHolder, actor: LiveActor, name: string, modelName: string, baseMtxPtr: mat4 = actor.getBaseMtx()!): void {
    const controller = createShadowControllerVolumeParam(sceneObjHolder, actor, name);
    const drawer = new ShadowVolumeFlatModel(sceneObjHolder, controller, modelName);
    controller.shadowDrawer = drawer;
    controller.setCalcCollisionMode(CalcCollisionMode.Off);
    drawer.setBaseMtxPtr(baseMtxPtr);
}

export function initShadowController(actor: LiveActor): void {
    actor.shadowControllerList = new ShadowControllerList();
}

export function initShadowSurfaceCircle(sceneObjHolder: SceneObjHolder, actor: LiveActor, radius: number): void {
    initShadowController(actor);
    addShadowSurfaceCircle(sceneObjHolder, actor, 'default', radius);
}

export function initShadowVolumeSphere(sceneObjHolder: SceneObjHolder, actor: LiveActor, radius: number): void {
    initShadowController(actor);
    addShadowVolumeSphere(sceneObjHolder, actor, 'default', radius);
}

export function initShadowVolumeCylinder(sceneObjHolder: SceneObjHolder, actor: LiveActor, radius: number): void {
    initShadowController(actor);
    addShadowVolumeCylinder(sceneObjHolder, actor, 'default', radius);
}

export function initShadowVolumeFlatModel(sceneObjHolder: SceneObjHolder, actor: LiveActor, modelName: string, baseMtxPtr: mat4 = actor.getBaseMtx()!): void {
    initShadowController(actor);
    addShadowVolumeFlatModel(sceneObjHolder, actor, 'default', modelName, baseMtxPtr);
}

export function setShadowDropPositionPtr(actor: LiveActor, name: string | null, v: ReadonlyVec3): void {
    actor.shadowControllerList!.getController(name).setDropPosPtr(v);
}

export function setShadowDropPosition(actor: LiveActor, name: string | null, v: ReadonlyVec3): void {
    actor.shadowControllerList!.getController(name).setDropPosFix(v);
}

export function setShadowDropLength(actor: LiveActor, name: string | null, v: number): void {
    actor.shadowControllerList!.getController(name).setDropLength(v);
}

export function onCalcShadow(actor: LiveActor, name: string | null = null): void {
    actor.shadowControllerList!.getController(name).setCalcCollisionMode(CalcCollisionMode.On);
}

export function onCalcShadowOneTime(actor: LiveActor, name: string | null = null): void {
    actor.shadowControllerList!.getController(name).setCalcCollisionMode(CalcCollisionMode.OneTime);
}

export function onCalcShadowDropPrivateGravityOneTime(actor: LiveActor, name: string | null = null): void {
    actor.shadowControllerList!.getController(name).setCalcDropGravityMode(CalcDropGravityMode.PrivateOneTime);
}

export function onCalcShadowDropPrivateGravity(actor: LiveActor, name: string | null = null): void {
    actor.shadowControllerList!.getController(name).setCalcDropGravityMode(CalcDropGravityMode.PrivateOn);
}

export function onCalcShadowDropGravityOneTime(actor: LiveActor, name: string | null = null): void {
    actor.shadowControllerList!.getController(name).setCalcDropGravityMode(CalcDropGravityMode.OneTime);
}

export function onCalcShadowDropGravity(actor: LiveActor, name: string | null = null): void {
    actor.shadowControllerList!.getController(name).setCalcDropGravityMode(CalcDropGravityMode.On);
}

function getShadowVolumeSphere(actor: LiveActor, name: string | null): ShadowVolumeSphere {
    return actor.shadowControllerList!.getController(name).shadowDrawer as ShadowVolumeSphere;
}

export function setShadowVolumeSphereRadius(actor: LiveActor, name: string | null, v: number): void {
    getShadowVolumeSphere(actor, name).radius = v;
}