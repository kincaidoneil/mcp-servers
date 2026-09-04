// The deck. A mouse drag moves the top card directly, since a pointer reports
// its own release. A trackpad never reports the fingers lifting, so the deck
// sits in a native scroller with three snap points, left, centre and right:
// the browser owns the gesture, holds the card wherever the fingers are, and
// only lands on a side once the fingers actually lift. Landing there is the
// decision.
//
// A leaving card becomes a detached "ghost" that finishes its flight while
// the next card is already live, so a fast run of keypresses never waits on
// an animation.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import { DISPOSE, KEEP, type Item } from "../../../schema";
import { Card } from "./Card";

export type ExitKind = "keep" | "dispose" | "skip" | "fade";

export interface StackApi {
  // Animate `itemId` off the deck. The caller updates state in the same tick.
  exit(itemId: string, kind: ExitKind): void;
}

interface CardStackProps {
  items: Item[];
  onSwipe: (itemId: string, action: typeof KEEP | typeof DISPOSE) => void;
  onOpenLink: (url: string) => void;
  apiRef: MutableRefObject<StackApi | null>;
  // Written by the stack: -1 fully toward dispose, 1 fully toward keep.
  pull: MotionValue<number>;
}

interface Ghost {
  key: number;
  item: Item;
  kind: ExitKind;
  fromX: number;
  fromY: number;
  fromOpacity: number;
  // Horizontal speed at release, so the exit continues the gesture.
  fromVx: number;
}

const VISIBLE_BEHIND = 2;
const EASE_OUT = [0.2, 0, 0, 1] as const;
const SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 } as const;
const SETTLE = { type: "spring", stiffness: 420, damping: 38 } as const;
// The live card's tilt, so a leaving card starts at the angle it ended on.
const ROTATE_PER_PX = 9 / 320;
// How far the scroller travels to either side. The browser lands on whichever
// snap point is nearest when the gesture ends, so half of this is the distance
// a swipe has to cover to decide.
export const THROW = 260;

export function CardStack({ items, onSwipe, onOpenLink, apiRef, pull }: CardStackProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion() ?? false;
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const opacity = useMotionValue(1);
  // How far the scroller has carried the card, in the same units as `x`.
  const scrolled = useMotionValue(0);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [dragging, setDragging] = useState(false);
  const ghostSeq = useRef(0);
  const lastExit = useRef(new Map<string, ExitKind>());
  const top = items[0];
  const topId = top?.id;

  const stageWidth = () => stageRef.current?.clientWidth ?? 480;
  const commitDistance = () => Math.min(140, stageWidth() * 0.34);
  const flyDistance = () => stageWidth() * 0.75;

  const latest = useRef({ items, onSwipe });
  latest.current = { items, onSwipe };

  const travel = useTransform(() => x.get() + scrolled.get());
  const rotate = useTransform(travel, (value) => value * ROTATE_PER_PX);
  // The card stays solid through the gesture and thins over the last stretch,
  // so it is nearly gone by the time it reaches the panel's edge.
  const dragFade = useTransform(travel, [-260, -150, 0, 150, 260], [0.12, 1, 1, 1, 0.12]);
  const topOpacity = useTransform(() => dragFade.get() * opacity.get());

  // The glow follows the card, easing in late so a small nudge shows almost
  // nothing and the light arrives as the card nears the decision.
  const applyPull = useCallback(
    (offset: number, distance: number) => {
      const ratio = Math.max(-1, Math.min(1, offset / distance));
      pull.set(Math.sign(ratio) * Math.abs(ratio) ** 2.2);
    },
    [pull],
  );

  const releasePull = useCallback(() => {
    if (reduceMotion) pull.set(0);
    else animate(pull, 0, { duration: 0.3, ease: EASE_OUT });
  }, [pull, reduceMotion]);

  // Put the scroller back at its centre without the browser animating there.
  const recentre = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.style.scrollSnapType = "none";
    el.scrollLeft = THROW;
    scrolled.set(0);
    requestAnimationFrame(() => {
      el.style.scrollSnapType = "";
    });
  }, [scrolled]);

  function launchGhost(itemId: string, kind: ExitKind, velocity = 0) {
    const item = latest.current.items.find((i) => i.id === itemId);
    if (!item) return;
    const isTop = latest.current.items[0]?.id === itemId;
    lastExit.current.set(itemId, kind);
    setGhosts((current) => [
      ...current,
      {
        key: ++ghostSeq.current,
        item,
        kind,
        // The ghost starts exactly where the card was, however it got there.
        fromX: isTop ? travel.get() : 0,
        fromY: isTop ? y.get() : 0,
        fromOpacity: isTop ? dragFade.get() : 1,
        fromVx: isTop ? velocity : 0,
      },
    ]);
    // `x` is not reset here: the outgoing card keeps its position for the
    // frame it is still on screen, and the layout effect below zeroes it as
    // the next card mounts. Resetting now makes the card jump to centre for
    // one frame before the ghost appears.
    if (isTop) recentre();
    releasePull();
  }

  apiRef.current = { exit: launchGhost };

  function commitSwipe(direction: 1 | -1, velocity = 0) {
    const item = latest.current.items[0];
    if (!item) return;
    const action = direction > 0 ? KEEP : DISPOSE;
    launchGhost(item.id, action, velocity);
    latest.current.onSwipe(item.id, action);
  }

  function settleBack() {
    releasePull();
    if (reduceMotion) {
      x.jump(0);
      y.jump(0);
      return;
    }
    animate(x, 0, SPRING);
    animate(y, 0, SPRING);
  }

  // The next card starts centred, and a card returning after undo slides in
  // from where it left.
  useLayoutEffect(() => {
    if (!topId) return;
    const kind = lastExit.current.get(topId);
    lastExit.current.delete(topId);
    if (!kind || reduceMotion) {
      x.jump(0);
      y.jump(0);
      opacity.jump(1);
      return;
    }
    const distance = flyDistance();
    x.jump(kind === "keep" ? distance : kind === "dispose" ? -distance : 0);
    y.jump(kind === "skip" ? 80 : 0);
    opacity.jump(kind === "fade" ? 0 : 1);
    animate(x, 0, SPRING);
    animate(y, 0, SPRING);
    animate(opacity, 1, { duration: 0.2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topId]);

  // Start centred, and follow the scroller. A swipe decides only when the
  // browser has finished the gesture and landed on a side, which is after the
  // fingers lift: `scrollend` fires past the momentum and the snap. Where it
  // is unsupported, a pause counts only at a snap point, so holding the card
  // part way still decides nothing.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollLeft = THROW;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const hasScrollEnd = "onscrollend" in window;

    const landed = () => {
      const offset = THROW - el.scrollLeft;
      if (Math.abs(offset) < THROW - 1) return;
      if (!latest.current.items[0]) {
        recentre();
        return;
      }
      commitSwipe(offset > 0 ? 1 : -1);
    };

    const onScroll = () => {
      scrolled.set(THROW - el.scrollLeft);
      applyPull(THROW - el.scrollLeft, THROW);
      if (hasScrollEnd) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(landed, 120);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    if (hasScrollEnd) el.addEventListener("scrollend", landed);
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (hasScrollEnd) el.removeEventListener("scrollend", landed);
      if (idle) clearTimeout(idle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pointer drag on the top card. Horizontal intent is required before the
  // card follows.
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    lastX: number;
    lastT: number;
    vx: number;
  } | null>(null);
  const suppressClickUntil = useRef(0);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !top) return;
    const target = event.target as HTMLElement;
    if (target.closest("a, button")) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      lastX: event.clientX,
      lastT: performance.now(),
      vx: 0,
    };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const dx = event.clientX - d.startX;
    const dy = event.clientY - d.startY;
    if (!d.active) {
      if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        d.active = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      } else if (Math.abs(dy) > 10) {
        drag.current = null;
        return;
      } else {
        return;
      }
    }
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    const instant = ((event.clientX - d.lastX) / dt) * 1000;
    d.vx = d.vx * 0.6 + instant * 0.4;
    d.lastX = event.clientX;
    d.lastT = now;
    x.set(dx);
    y.set(dy * 0.22);
    applyPull(dx, commitDistance());
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!d.active) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    suppressClickUntil.current = performance.now() + 150;
    const current = x.get();
    // A flick commits early, but only past a real distance: synthetic or
    // jittery input can report huge velocities over a few pixels.
    const flung =
      Math.abs(d.vx) > 700 && Math.sign(d.vx) === Math.sign(current) && Math.abs(current) > 90;
    if (!cancelled && (Math.abs(current) >= commitDistance() || flung)) {
      commitSwipe(current > 0 ? 1 : -1, d.vx);
    } else {
      settleBack();
    }
  }

  const behind = items.slice(1, 1 + VISIBLE_BEHIND);

  return (
    <div ref={stageRef} className="pare-stage">
      <div ref={scrollerRef} className="pare-scroller" data-testid="scroller">
        <div className="pare-throw" style={{ width: THROW }} aria-hidden />
        <div className="pare-frame">
          {behind.toReversed().map((item, i) => {
            const depth = behind.length - i;
            return (
              <motion.div
                key={item.id}
                className="pare-card pare-card--behind"
                initial={false}
                animate={{ scale: 1 - depth * 0.03, y: depth * 6 }}
                transition={reduceMotion ? { duration: 0 } : SETTLE}
                style={{ zIndex: 10 - depth }}
                aria-hidden
              >
                <Card item={item} />
              </motion.div>
            );
          })}

          {top && (
            <motion.div
              key={top.id}
              className={"pare-card pare-card--top" + (dragging ? " is-dragging" : "")}
              style={{ x, y, rotate, opacity: topOpacity }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => endDrag(e, false)}
              onPointerCancel={(e) => endDrag(e, true)}
              onClickCapture={(e) => {
                if (performance.now() < suppressClickUntil.current) {
                  e.stopPropagation();
                  e.preventDefault();
                }
              }}
              data-testid="top-card"
              data-item-id={top.id}
            >
              <Card item={top} onOpenLink={onOpenLink} />
            </motion.div>
          )}
        </div>
        <div className="pare-throw" style={{ width: THROW }} aria-hidden />
      </div>

      {ghosts.map((ghost) => (
        <GhostCard
          key={ghost.key}
          ghost={ghost}
          flyDistance={flyDistance()}
          reduceMotion={reduceMotion}
          onDone={() => setGhosts((current) => current.filter((g) => g.key !== ghost.key))}
        />
      ))}
    </div>
  );
}

function GhostCard({
  ghost,
  flyDistance,
  reduceMotion,
  onDone,
}: {
  ghost: Ghost;
  flyDistance: number;
  reduceMotion: boolean;
  onDone: () => void;
}) {
  const { kind, fromX, fromY, fromOpacity, fromVx } = ghost;
  const flying = kind === "keep" || kind === "dispose";
  const direction = kind === "keep" ? 1 : -1;
  const target = flying
    ? { x: direction * flyDistance, y: fromY + 18, rotate: direction * 13, opacity: 0 }
    : kind === "skip"
      ? { x: fromX, y: 64, rotate: 0, scale: 0.96, opacity: 0 }
      : { x: fromX, y: fromY - 8, rotate: 0, scale: 0.94, opacity: 0 };
  // The card leaves at the speed it was released with, so the flight reads as
  // one motion with the gesture rather than a new animation.
  const transition = reduceMotion
    ? { duration: 0 }
    : flying
      ? {
          x: { type: "spring", stiffness: 140, damping: 24, mass: 0.9, velocity: fromVx },
          y: { duration: 0.34, ease: EASE_OUT },
          rotate: { duration: 0.34, ease: EASE_OUT },
          opacity: { duration: 0.3, ease: EASE_OUT },
        }
      : { duration: 0.24, ease: EASE_OUT };

  return (
    <motion.div
      className="pare-card pare-card--ghost"
      initial={{
        x: fromX,
        y: fromY,
        rotate: fromX * ROTATE_PER_PX,
        opacity: fromOpacity,
        scale: 1,
      }}
      animate={target}
      transition={transition}
      onAnimationComplete={onDone}
      aria-hidden
    >
      <Card item={ghost.item} />
    </motion.div>
  );
}
