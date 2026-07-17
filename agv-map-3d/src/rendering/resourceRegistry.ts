/*
 * 可释放资源登记与幂等释放（rendering 层，SPEC 4.3 / 任务约束）。
 *
 * 定位（TASK-014）：
 *   - 本模块是 Three 资源（Geometry / Material / Texture / InstancedMesh 等带 dispose() 的对象）
 *     的统一登记与成对释放机制；资源创建方登记，由资源集合的 dispose() 一次性幂等释放。
 *   - 不创建任何 Three 对象，只持有释放回调并保证“恰好一次有效清理”。
 *
 * 幂等释放不变量（SPEC 4.3 / 任务“StrictMode 风格重复调用” / 验收“重复释放不抛异常”）：
 *   - dispose() 首次调用按登记逆序执行全部释放回调；此后任意次调用均为空操作。
 *   - 每个已登记资源恰好被清理一次（回调只出现在登记表一次，执行后登记表清空）；
 *     登记数量在释放后归零且不因重复释放而增长。
 *   - 已释放后再次 register 的资源会被立即清理，避免在已关闭集合上泄漏新资源。
 *
 * 创建原子性配合（任务“创建中途失败必须释放已分配资源”）：
 *   - mapResources 工厂在 try/catch 中登记每一步创建的资源；任一步骤抛出时，
 *     catch 分支调用 registry.dispose() 释放本次已登记资源，禁止把清理责任转嫁给场景层。
 *
 * 依赖方向（SPEC 3.3）：仅本层自身，无内部依赖；不依赖 Three（只约定 dispose() 协议形状）。
 */

/*
 * 可释放资源协议：任何带无参 dispose() 的对象（Three Geometry / Material / InstancedMesh 等）。
 * 普通 THREE.Mesh 没有 dispose()，故只登记真正持有 GPU 资源的子资源（geometry / material / 实例属性）。
 */
export interface Disposable {
  dispose(): void
}

/*
 * 资源登记与幂等释放器。
 *
 * 字段语义：
 *   - resources：已登记的可释放资源（按登记顺序）；dispose 时逆序释放，模拟栈式生命周期。
 *   - disposed：幂等标志，首次 dispose 后置 true，阻断重复释放。
 */
export class ResourceRegistry {
  private readonly resources: Disposable[] = []
  private disposed = false

  /*
   * 当前登记数量（供测试与诊断观察幂等释放不变量）。
   * 释放后归零；重复释放不再增长。
   */
  get size(): number {
    return this.resources.length
  }

  /*
   * 是否已完成首次释放。
   */
  get isDisposed(): boolean {
    return this.disposed
  }

  /*
   * 登记一个可释放资源；返回资源本身，便于“构造即登记”的链式写法。
   *
   * 已释放后登记：立即清理新资源并返回，避免在已关闭集合上泄漏。
   * 这一支路保证无论创建顺序如何，已释放集合都不会持有未清理的新资源。
   */
  register<T extends Disposable>(resource: T): T {
    if (this.disposed) {
      resource.dispose()
      return resource
    }
    this.resources.push(resource)
    return resource
  }

  /*
   * 幂等释放：首次调用按登记逆序执行每个资源的 dispose()。
   *
   * 逆序释放：后创建的资源先释放，贴近“后来者依赖先来者”的典型生命周期，
   * 例如 InstancedMesh 的实例属性先于其共享几何 / 材质释放。
   *
   * 异常隔离：单个资源 dispose 抛错时不阻断其余资源释放（Three dispose 实践中不抛错，
   * 此处仅作防御），保证“尽可能释放全部已登记资源”。
   */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    // splice(0) 把登记项移入新数组并清空 this.resources；二者不再共享引用，
    // 否则对 this.resources.length = 0 会同步清空 pending，导致跳过全部释放。
    const pending = this.resources.splice(0)
    for (let i = pending.length - 1; i >= 0; i--) {
      try {
        pending[i].dispose()
      } catch {
        // 单资源释放失败不阻断其余资源；继续逆序释放剩余登记项。
      }
    }
  }
}
