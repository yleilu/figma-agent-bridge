// Single source of the component `properties` projection shared by
// get_components (READ) and update_component (WRITE). Both must emit the SAME
// {id,name,type,defaultValue,variantOptions?} array so the get_components ↔
// update_component round-trip holds by construction (read == write, T2) instead
// of by two hand-maintained inline copies.
//
// The defs object key is the CANONICAL property id (e.g. "Label#1:0") → `id`;
// the human name is the part before "#" → `name`. variantOptions is carried
// only for VARIANT definitions that actually have options.
//
// The input type is declared structurally (not via the figma global
// `ComponentPropertyDefinitions`) so this module stays free of the figma
// runtime and is independently unit-testable. figma's
// ComponentPropertyDefinitions is structurally assignable to it.

export type ComponentPropertyDef = {
  type: string
  defaultValue: string | boolean
  variantOptions?: string[]
}

export type ComponentPropertyDefMap = {
  [propertyName: string]: ComponentPropertyDef
}

export type ProjectedComponentProperty = {
  id: string
  name: string
  type: string
  defaultValue: string | boolean
  variantOptions?: string[]
}

export const projectComponentDefs = (
  defs: ComponentPropertyDefMap,
): ProjectedComponentProperty[] =>
  Object.keys(defs).map(key => {
    const def = defs[key]
    const hashIdx = key.indexOf('#')
    const entry: ProjectedComponentProperty = {
      id: key,
      name: hashIdx >= 0 ? key.slice(0, hashIdx) : key,
      type: def.type,
      defaultValue: def.defaultValue,
    }
    if (def.type === 'VARIANT' && def.variantOptions) {
      entry.variantOptions = def.variantOptions
    }
    return entry
  })
