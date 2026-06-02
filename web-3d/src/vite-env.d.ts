/// <reference types="vite/client" />

/**
 * Shader 文件以原始字符串导入
 * 用法：import source from './shader.vert?raw'
 */
declare module '*.vert?raw' {
  const content: string
  export default content
}

declare module '*.frag?raw' {
  const content: string
  export default content
}
