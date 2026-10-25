import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import { memo, useContext } from 'react';
import { STATE_COLOR, type NodeState } from '../run/state';
import { RunViews } from './HiveNode';
import { useBeginOnMount } from './NodeFx';

const ACTIVE = new Set<NodeState>(['loading', 'thinking', 'streaming']);

/**
 * A wire that shows data moving: particles stream from a finished block into the block that is working,
 * and a single pulse runs through once the target is done. Driven only by run events.
 */
function HiveEdgeImpl({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }: EdgeProps<Edge>) {
  const views = useContext(RunViews);
  const src = views[source]?.state;
  const dst = views[target]?.state;
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: 0.35 });

  const live = src === 'done' && !!dst && ACTIVE.has(dst);
  const delivered = src === 'done' && dst === 'done';
  const color = live ? STATE_COLOR[dst!] : delivered || src === 'done' ? STATE_COLOR.done : src === 'error' ? STATE_COLOR.error : '#3b434d';
  // Faster particles while writing, slow drifting ones while thinking or loading.
  const speed = dst === 'streaming' ? 1.1 : dst === 'thinking' ? 2.2 : 2.8;
  const count = dst === 'streaming' ? 5 : 3;

  return (
    <>
      {(live || delivered) && (
        <path d={path} fill="none" stroke={color} strokeWidth={live ? 10 : 6} strokeOpacity={live ? 0.18 : 0.08} style={{ filter: 'blur(4px)' }} />
      )}
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: selected ? '#818cf8' : color,
          strokeWidth: live ? 2.5 : delivered ? 2 : 1.75,
          strokeDasharray: live ? '6 6' : undefined,
          animation: live ? 'hm-dash 0.8s linear infinite' : undefined,
        }}
      />
      {live &&
        Array.from({ length: count }, (_, i) => (
          <circle key={`${dst}-${i}`} r={i === 0 ? 4 : 3} fill={color} style={{ filter: `drop-shadow(0 0 6px ${color})` }}>
            <animateMotion dur={`${speed}s`} begin={`${(i * speed) / count}s`} repeatCount="indefinite" path={path} keyPoints="0;1" keyTimes="0;1" calcMode="linear" />
            <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.85;1" dur={`${speed}s`} begin={`${(i * speed) / count}s`} repeatCount="indefinite" />
          </circle>
        ))}
      {delivered && <DonePulse key={`done-${views[target]?.elapsedMs}`} path={path} />}
    </>
  );
}

/** One bright pulse that runs through the wire once, when the target block finished. */
function DonePulse({ path }: { path: string }) {
  const move = useBeginOnMount<SVGAnimateMotionElement>();
  const fade = useBeginOnMount<SVGAnimateElement>();
  return (
    <circle r={5} fill="#a7f3d0" opacity={0} style={{ filter: 'drop-shadow(0 0 8px #34d399)' }}>
      <animateMotion ref={move} begin="indefinite" dur="0.9s" fill="freeze" path={path} />
      <animate ref={fade} attributeName="opacity" begin="indefinite" values="1;1;0" keyTimes="0;0.8;1" dur="0.9s" fill="freeze" />
    </circle>
  );
}

export const HiveEdge = memo(HiveEdgeImpl);
