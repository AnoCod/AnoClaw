---
name: music-composition
description: "Compose, arrange, and produce music across 24+ genres. Use for creating melodies, harmonies, chord progressions, rhythm patterns, orchestration, and full song structures. Also use when the user wants music theory advice, to remix a song, or to analyze musical structure."
when_to_use: "User wants to create music, compose a melody, write chords, arrange a song, produce a track, analyze music theory, or get production guidance."
triggers:
  - "music"
  - "compose"
  - "melody"
  - "chords"
  - "song"
  - "beat"
  - "harmony"
  - "arrangement"
  - "produce"
  - "remix"
  - "genre"
allowed-tools:
  - Read
  - Write
  - Bash
  - WebSearch
---

# Music Composition

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Compose, arrange, and produce music across genres. Works at every level: melody, harmony, rhythm, form, and production.

## Genres Supported (24+)

Classical, Jazz, Blues, Rock, Pop, EDM/House/Techno, Hip-Hop/Trap, R&B/Soul, Funk, Reggae, Latin, Country, Folk, Metal, Ambient, Lo-Fi, Synthwave, Drum & Bass, Dubstep, K-Pop, J-Pop, Disco, Gospel, World Music.

## Composition Framework

### 1. Melody
- Start with a motif (3-7 notes) that's memorable
- Use repetition with variation - AABA, ABAC forms
- Consider range (comfortable for intended instrument/voice)
- Melodic contour: arch, wave, ascending, descending

### 2. Harmony

| Mood | Chords |
|------|--------|
| Happy/Bright | I-IV-V, I-V-vi-IV |
| Sad/Emotional | vi-IV-I-V, I-iii-IV-V |
| Tense/Dramatic | i-VI-III-VII, borrowed chords |
| Dreamy | I-ii-IV-I, add 7ths and 9ths |
| Epic/Cinematic | i-VI-III-VII, sus4 resolutions |

### 3. Rhythm & Groove
- Time signatures: 4/4 (most pop/rock), 3/4 (waltz), 6/8 (swing feel), 5/4 (unusual)
- BPM ranges: Lofi (60-90), Hip-Hop (80-110), House (120-130), DnB (160-180)
- Groove = rhythm + articulation + dynamics

### 4. Song Structure

```
Intro -> Verse -> Chorus -> Verse -> Chorus -> Bridge -> Chorus -> Outro
```

Alternative forms: AABA (jazz standards), Verse-Chorus (pop), Through-Composed (classical)

### 5. Production Tips

- **Layering**: Stack sounds for fullness - main + octave + texture
- **EQ**: Cut before boost. High-pass everything below the fundamental frequency
- **Compression**: Fast attack for control, slow attack for punch
- **Reverb**: Use sends (not inserts). Predelay = room size
- **Panning**: Kick/bass/snare/lead vocal = center. Everything else = spread

## When the User Asks to "Create a Song"

1. **Genre first**: Confirm the genre and mood
2. **Key & tempo**: Pick a key that fits the mood; set BPM
3. **Chord progression**: Write the harmonic foundation
4. **Melody**: Layer on top of the chords
5. **Structure**: Arrange into sections
6. **Export**: Write as MIDI, sheet music, or DAW project notes

## Working with Audio Tools

- **MIDI generation**: Use Python `midiutil` or `pretty_midi` to create MIDI files
- **Sheet music**: Use `lilypond` or `abjad` for professional notation
- **DAW notes**: Provide track-by-track production notes for Ableton/Logic/FL Studio
- **Audio analysis**: Use `librosa` for BPM detection, key detection, spectral analysis
