figma.showUI(__html__, { width: 340, height: 280, title: 'Agent Bridge', themeColors: true });

figma.ui.postMessage({ type: 'file-name', fileName: figma.root.name });

type PluginMessage =
  | { type: 'execute-command'; id: string; command: string; params: Record<string, unknown> }
  | { type: 'storage-get'; key: string }
  | { type: 'storage-set'; key: string; value: unknown }
  | { type: 'storage-delete'; key: string };

const summarizeChildren = (node: BaseNode & { children?: readonly BaseNode[] }) =>
  'children' in node && node.children
    ? node.children.map((child) => ({ id: child.id, name: child.name, type: child.type }))
    : [];

const exportNodeDocument = async (node: BaseNode): Promise<unknown> => {
  if (node.type === 'DOCUMENT' || node.type === 'PAGE') {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      children: summarizeChildren(node),
    };
  }
  const exported = await (node as SceneNode).exportAsync({ format: 'JSON_REST_V1' });
  if (typeof exported === 'object' && exported !== null && (exported as Record<string, unknown>).document) {
    return (exported as Record<string, unknown>).document;
  }
  throw new Error('exportAsync returned unexpected type: ' + typeof exported);
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let b64 = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    const b1 = i < bytes.length ? bytes[i++] : 0;
    const b2 = i < bytes.length ? bytes[i++] : 0;
    b64 += CHARS[b0 >> 2];
    b64 += CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    b64 += CHARS[((b1 & 15) << 2) | (b2 >> 6)];
    b64 += CHARS[b2 & 63];
  }
  const pad = bytes.length % 3;
  if (pad === 1) {
    b64 = b64.slice(0, -2) + '==';
  } else if (pad === 2) {
    b64 = b64.slice(0, -1) + '=';
  }
  return b64;
};

const bytesToString = (bytes: Uint8Array): string => {
  let result = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = i + chunkSize < bytes.length ? i + chunkSize : bytes.length;
    const slice = bytes.slice(i, end);
    result += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return result;
};

const handleCommand = async (command: string, params: Record<string, unknown>): Promise<unknown> => {
  switch (command) {
    case 'get_document_info':
      return {
        name: figma.root.name,
        currentPage: {
          id: figma.currentPage.id,
          name: figma.currentPage.name,
        },
      };

    case 'get_selection':
      return figma.currentPage.selection.map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
      }));

    case 'get_node': {
      const node = await figma.getNodeByIdAsync(params.nodeId as string);
      if (!node) {
        return { error: 'Node not found: ' + params.nodeId };
      }
      return exportNodeDocument(node);
    }

    case 'get_nodes': {
      const nodeIds = (params.nodeIds as string[]) || [];
      return Promise.all(
        nodeIds.map(async (nodeId) => {
          const node = await figma.getNodeByIdAsync(nodeId);
          if (!node) {
            return { id: nodeId, error: 'Node not found' };
          }
          return exportNodeDocument(node);
        }),
      );
    }

    case 'get_page_layout': {
      return {
        pageName: figma.currentPage.name,
        frames: figma.currentPage.children.map((frame) => ({
          id: frame.id,
          name: frame.name,
          type: frame.type,
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height,
          childCount: 'children' in frame ? (frame as SceneNode & ChildrenMixin).children.length : 0,
        })),
      };
    }

    case 'get_pages':
      return figma.root.children.map((page) => ({
        id: page.id,
        name: page.name,
        isCurrent: page.id === figma.currentPage.id,
        childCount: page.children ? page.children.length : 0,
      }));

    case 'export_node': {
      const exportNode = await figma.getNodeByIdAsync(params.nodeId as string) as SceneNode | null;
      if (!exportNode) {
        return { error: 'Node not found: ' + params.nodeId };
      }
      const exportFormat = (params.format as 'PNG' | 'JPG' | 'SVG' | 'PDF') || 'PNG';
      const exportScale = (params.scale as number) || 1;
      const bytes = await exportNode.exportAsync({
        format: exportFormat,
        constraint: { type: 'SCALE', value: exportScale },
      });
      const data = exportFormat === 'SVG' ? bytesToString(bytes) : bytesToBase64(bytes);
      return { format: exportFormat, scale: exportScale, data };
    }

    case 'get_styles': {
      const paintStyles = figma.getLocalPaintStyles().map((s) => ({
        id: s.id,
        name: s.name,
        paints: s.paints.map((p) => ({
          type: p.type,
          color: p.type === 'SOLID' ? (p as SolidPaint).color : undefined,
          opacity: p.opacity,
        })),
      }));
      const textStyles = figma.getLocalTextStyles().map((s) => ({
        id: s.id,
        name: s.name,
        fontFamily: s.fontName.family,
        fontStyle: s.fontName.style,
        fontSize: s.fontSize,
        lineHeight: s.lineHeight.unit === 'PIXELS' ? (s.lineHeight as { unit: 'PIXELS'; value: number }).value : null,
      }));
      const effectStyles = figma.getLocalEffectStyles().map((s) => ({
        id: s.id,
        name: s.name,
        effects: s.effects.map((e) => ({
          type: e.type,
          color: 'color' in e ? (e as DropShadowEffect | InnerShadowEffect).color : undefined,
          offset: 'offset' in e ? (e as DropShadowEffect | InnerShadowEffect).offset : undefined,
          radius: 'radius' in e ? (e as DropShadowEffect | InnerShadowEffect | BlurEffectNormal).radius : undefined,
          spread: 'spread' in e ? (e as DropShadowEffect | InnerShadowEffect).spread : undefined,
        })),
      }));
      const gridStyles = figma.getLocalGridStyles().map((s) => ({ id: s.id, name: s.name }));
      return { paint: paintStyles, text: textStyles, effect: effectStyles, grid: gridStyles };
    }

    case 'get_local_components': {
      const componentSets = figma.root.findAllWithCriteria({ types: ['COMPONENT_SET'] });
      const components = figma.root.findAllWithCriteria({ types: ['COMPONENT'] });

      const setMap: Record<string, unknown> = {};
      for (const cs of componentSets) {
        const variantKeys: Record<string, string[]> = {};
        if (cs.children) {
          for (const variant of cs.children) {
            const props = (variant as ComponentNode).variantProperties;
            if (props) {
              for (const pkey of Object.keys(props)) {
                if (!variantKeys[pkey]) { variantKeys[pkey] = []; }
                if (!variantKeys[pkey].includes(props[pkey])) {
                  variantKeys[pkey].push(props[pkey]);
                }
              }
            }
          }
        }
        const csDefs = cs.componentPropertyDefinitions || {};
        const csProps = Object.keys(csDefs).map((key) => ({
          name: key,
          type: csDefs[key].type,
          default: csDefs[key].defaultValue,
        }));
        setMap[cs.id] = {
          id: cs.id,
          name: cs.name,
          page: cs.parent && cs.parent.type === 'PAGE' ? cs.parent.name : null,
          variants: Object.keys(variantKeys).length > 0 ? variantKeys : null,
          properties: csProps,
        };
      }

      const standaloneComponents: unknown[] = [];
      for (const comp of components) {
        if (comp.parent && comp.parent.type === 'COMPONENT_SET') {
          continue;
        }
        const compDefs = comp.componentPropertyDefinitions || {};
        const compProps = Object.keys(compDefs).map((key) => ({
          name: key,
          type: compDefs[key].type,
          default: compDefs[key].defaultValue,
        }));
        standaloneComponents.push({
          id: comp.id,
          name: comp.name,
          page: comp.parent && comp.parent.type === 'PAGE' ? comp.parent.name : null,
          variants: null,
          properties: compProps,
        });
      }

      const instances = figma.root.findAllWithCriteria({ types: ['INSTANCE'] });
      const remoteMap: Record<string, { key: string; name: string; library: string; instancesCount: number }> = {};
      for (const inst of instances) {
        const main = inst.mainComponent;
        if (main && main.remote) {
          const mkey = main.key;
          if (!remoteMap[mkey]) {
            remoteMap[mkey] = {
              key: mkey,
              name: main.name,
              library: main.parent && main.parent.name ? main.parent.name : 'Unknown',
              instancesCount: 0,
            };
          }
          remoteMap[mkey].instancesCount++;
        }
      }

      const localAll = Object.values(setMap).concat(standaloneComponents);
      const remoteAll = Object.values(remoteMap);

      return { local: localAll, remote: remoteAll };
    }

    case 'search_nodes': {
      const searchName = (params.name as string) || '';
      const searchType = (params.type as string) || null;
      const searchPageId = (params.pageId as string) || null;
      const searchLimit = (params.limit as number) || 50;

      const searchPages: PageNode[] = [];
      if (searchPageId) {
        const pageNode = await figma.getNodeByIdAsync(searchPageId);
        if (pageNode && pageNode.type === 'PAGE') {
          searchPages.push(pageNode as PageNode);
        }
      } else {
        for (const page of figma.root.children) {
          searchPages.push(page);
        }
      }

      const globPattern = searchName.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const nameRegex = searchName ? new RegExp(globPattern, 'i') : null;

      const matches: unknown[] = [];
      for (const sp of searchPages) {
        const found = sp.findAll((node) => {
          if (nameRegex && !nameRegex.test(node.name)) { return false; }
          if (searchType && node.type !== searchType) { return false; }
          return true;
        });
        for (const fn of found) {
          if (matches.length >= searchLimit) { break; }
          matches.push({
            id: fn.id,
            name: fn.name,
            type: fn.type,
            page: sp.name,
            parent: fn.parent ? fn.parent.name + ' [' + fn.parent.id + ']' : null,
            width: 'width' in fn ? (fn as SceneNode & { width: number }).width : null,
            height: 'height' in fn ? (fn as SceneNode & { height: number }).height : null,
          });
        }
        if (matches.length >= searchLimit) { break; }
      }

      const truncated = matches.length >= searchLimit;
      return { results: matches.slice(0, searchLimit), truncated };
    }

    default:
      return { error: 'Unknown command: ' + command };
  }
};

figma.ui.onmessage = async (msg: PluginMessage) => {
  if (msg.type === 'execute-command') {
    let result: unknown;
    try {
      result = await handleCommand(msg.command, msg.params);
    } catch (err) {
      result = { error: String(err) };
    }

    figma.ui.postMessage({
      type: 'command-result',
      id: msg.id,
      result,
    });
  }

  if (msg.type === 'storage-get') {
    const value = await figma.clientStorage.getAsync(msg.key);
    figma.ui.postMessage({
      type: 'storage-result',
      key: msg.key,
      value: value !== undefined ? value : null,
    });
  }

  if (msg.type === 'storage-set') {
    await figma.clientStorage.setAsync(msg.key, msg.value);
  }

  if (msg.type === 'storage-delete') {
    await figma.clientStorage.deleteAsync(msg.key);
  }
};
