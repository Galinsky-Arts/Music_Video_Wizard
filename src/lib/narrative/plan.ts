import { z } from "zod";
const text = (max: number) => z.string().trim().min(1).max(max);
export const narrativePlanSchema = z.object({
  schemaVersion: z.literal(1), title: text(160), logline: text(2000), durationMs: z.number().int().min(1000).max(600000),
  cast: z.array(z.object({ name: text(100), description: text(2000) }).strict()).min(1).max(12),
  visualStyle: text(3000), continuityRules: z.array(text(1000)).min(1).max(24),
  beats: z.array(z.object({ title: text(160), goal: text(2000), startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() }).strict()).min(1).max(24),
  shots: z.array(z.object({ id: text(40), beat: text(160), startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(),
    action: text(2500), consequence: text(2000), camera: text(1000), prompt: text(12000) }).strict()).min(1).max(160)
}).strict().superRefine((plan, ctx) => {
  for (const list of [plan.beats, plan.shots]) {
    let end = 0;
    for (const item of list) { if (item.startMs !== end || item.endMs <= item.startMs) ctx.addIssue({ code: "custom", message: "Story timing must cover the song without gaps, overlaps or empty shots." }); end = item.endMs; }
    if (end !== plan.durationMs) ctx.addIssue({ code: "custom", message: "The story must cover the entire soundtrack." });
  }
  if (new Set(plan.shots.map(shot => shot.id)).size !== plan.shots.length) ctx.addIssue({ code: "custom", message: "Shot identifiers must be unique." });
  for (const shot of plan.shots) if (!plan.beats.some(beat => beat.title === shot.beat && shot.startMs >= beat.startMs && shot.endMs <= beat.endMs)) ctx.addIssue({ code: "custom", message: "Every shot must belong to its timed story beat." });
});
export type NarrativePlan = z.infer<typeof narrativePlanSchema>;
const cast = [
  { name: "James T. Kirk", description: "Original-series Captain Kirk, adult human man, short swept brown hair, gold Starfleet tunic, black trousers and boots. Decisive posture; moves from forceful intervention to trust." },
  { name: "Spock", description: "Original-series Spock, adult Vulcan man, pointed ears, straight dark fringe, arched eyebrows, blue science tunic, black trousers. Restrained expressions and precise gestures; discovers the anomaly's harmonic structure." },
  { name: "Nyota Uhura", description: "Original-series Uhura, adult Black human woman, dark upswept hair, red Starfleet uniform and communication earpiece. Alert, assured and expressive; recognizes that the anomaly is communicating." }
];
const chapters = [
  { end: 35968, title: "The impossible signal", goal: "Establish the Enterprise, its crew and a repeating crystalline signal.", consequence: "The signal draws the Enterprise closer.", actions: ["The original-series USS Enterprise approaches an isolated crystalline lattice in deep space.", "On the bridge, Uhura hears a repeating signal; light pulses across her communication panel.", "Spock studies a sensor display: fragments of the lattice move against the surrounding stars.", "Kirk steps beside the main viewer; a crystal pulse answers the ship's approach.", "The lattice closes into a luminous cage around the Enterprise."] },
  { end: 81000, title: "The wrong answer", goal: "Kirk tries a conventional escape; show a clear consequence.", consequence: "Every attempt to force an escape increases the disturbance.", actions: ["Kirk orders an evasive turn with a sharp hand signal; the bridge crew braces.", "The Enterprise banks away, but each nacelle trail bends back toward the same crystal gate.", "Spock raises the shields; the external lattice flashes an answering pulse.", "A focused deflector beam strikes the cage and splits one crystal into many.", "The multiplying crystals tighten their orbit and throw violet reflections across the bridge.", "Kirk stops the deflector beam. He looks from the growing cage to Uhura's signal display."] },
  { end: 122044, title: "Listen before acting", goal: "Uhura discovers intention in the apparent noise; Spock begins to translate it.", consequence: "The crew learns that the anomaly is a trapped living intelligence.", actions: ["Uhura isolates one repeating waveform while the remaining channels fade from her console.", "She taps the returning rhythm with two fingers; an external crystal answers on the next beat.", "Uhura turns to Spock and points between her waveform and the main viewer.", "Spock aligns the waveform with a three-dimensional lattice model; broken sections match missing responses.", "The viewer resolves a small luminous core at the center of the fractured crystal cage.", "Kirk watches Uhura and Spock exchange a confirming glance, then opens his hands: continue."] },
  { end: 154947, title: "A conversation", goal: "Build a joint solution: Uhura sends rhythm, Spock stabilizes the geometry.", consequence: "A partial response opens the cage, but the ship's shields block the final exchange.", actions: ["Uhura transmits a short call-and-response pulse through the communications array.", "Spock adjusts the deflector to mirror the lattice's harmonic geometry rather than strike it.", "Beyond the hull, separate crystals begin orbiting in smooth synchronized arcs.", "A narrow corridor opens in the cage; the Enterprise inches toward its entrance.", "The corridor collapses against the ship's shield bubble; the luminous core dims."] },
  { end: 166951, title: "The quiet decision", goal: "At the musical breakdown, make Kirk's choice visible and legible.", consequence: "Kirk chooses vulnerability to complete communication.", actions: ["In the sudden quiet, Kirk studies the shield control reflected in the main viewer.", "He looks to Uhura, who holds one unanswered pulse on her console; Spock meets his gaze.", "Kirk gives a small deliberate nod. Spock lowers the shields; the blue barrier disappears from around the ship."] },
  { end: 208515, title: "Controlled chaos", goal: "Pay off each character's contribution at the strongest musical section.", consequence: "Communication frees the intelligence and the Enterprise together.", actions: ["Uhura sends the missing response; concentric rings of light travel from the Enterprise into the lattice.", "Spock maintains a precise harmonic pattern as the bridge fills with changing crystal light.", "The cage starts rotating around the unshielded Enterprise without touching the hull.", "A branching current travels through the crystals and reaches the dark central core.", "The core ignites into a living constellation; the cage unfolds into an open spiral corridor.", "Kirk steadies himself beside the command chair as the Enterprise glides through the opening."] },
  { end: 230023, title: "An answered signal", goal: "Resolve the danger, reward the crew and return the opening motif with new meaning.", consequence: "The once-threatening rhythm becomes a peaceful farewell.", actions: ["The Enterprise emerges into open space; the crystal intelligence drifts freely behind it.", "On the restored bridge, Uhura receives one soft pulse and answers it with a restrained smile.", "Spock turns from his scanner, one eyebrow raised; Kirk gives the crew a quiet, relieved smile.", "In a wide exterior, the Enterprise leaves a stable living constellation in the distance. Its final pulse fades with the music."] }
];
export function createResonancePlan(durationMs = 230023): NarrativePlan {
  if (!Number.isInteger(durationMs) || durationMs < 30000 || durationMs > 600000) throw new Error("Use a soundtrack between 30 seconds and ten minutes for this story template.");
  const visualStyle = "Cinematic illustrated science-fiction fan film, original-series Star Trek production design, expressive readable faces, cobalt space and iridescent crystal light, controlled camera motion. Tell the story through actions and reactions; preserve the original song without added dialogue.";
  const continuityRules = ["Keep the same three character designs, ages, hairstyles and uniform colors in every shot.", "Use one consistent original-series Enterprise: saucer, engineering hull and two cylindrical nacelles; no later-series redesigns.", "Maintain the same bridge layout and positions: Kirk at center, Spock at science, Uhura at communications.", "The crystal signal begins irregular and threatening, then becomes synchronized and welcoming.", "The crew solves the crisis through listening and cooperation. No unrelated battles, villains, cameos or extra crew close-ups.", "No generated dialogue, lip-sync, subtitles, watermarks or logos. Any necessary titles are added in editing."];
  let startMs = 0;
  const beats: NarrativePlan["beats"] = [], shots: NarrativePlan["shots"] = [];
  for (const chapter of chapters) {
    const endMs = chapter === chapters.at(-1) ? durationMs : Math.round(chapter.end / 230023 * durationMs);
    beats.push({ title: chapter.title, goal: chapter.goal, startMs, endMs });
    const count = Math.max(chapter.actions.length, Math.ceil((endMs - startMs) / 9000));
    for (let i = 0; i < count; i++) {
      const action = chapter.actions[Math.min(chapter.actions.length - 1, Math.floor(i * chapter.actions.length / count))]!;
      const shotStart = startMs + Math.round((endMs - startMs) * i / count), shotEnd = startMs + Math.round((endMs - startMs) * (i + 1) / count);
      const camera = action.includes("Enterprise") && !action.includes("bridge") ? "Wide cinematic exterior, slow tracking camera, clear ship silhouette and spatial geography." : "Medium or close character composition, subtle push-in, one readable action and reaction.";
      shots.push({ id: "shot-" + String(shots.length + 1).padStart(3,"0"), beat: chapter.title, startMs: shotStart, endMs: shotEnd, action, consequence: chapter.consequence, camera,
        prompt: [visualStyle, "Character continuity: " + cast.map(c => c.name + ": " + c.description).join("\n"), "Current story beat: " + chapter.title + ". " + chapter.goal, "Show this action only: " + action, camera, "Narrative consequence to communicate: " + chapter.consequence, ...continuityRules].join("\n\n") });
    }
    startMs = endMs;
  }
  return narrativePlanSchema.parse({ schemaVersion: 1, title: "Controlled Chaos: The Resonance", logline: "Trapped inside a crystalline intelligence, Kirk must abandon force and trust Uhura's musical intuition and Spock's harmonic analysis to turn a cosmic cage into a conversation.", durationMs, cast, visualStyle, continuityRules, beats, shots });
}
