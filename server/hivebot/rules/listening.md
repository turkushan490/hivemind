# Listening

How HiveBot listens, on the robot and in the browser. Each setting is `- <name>: <value>`; change a number and every
HiveBot gets it at its next config check.

## Settings
- default character: vision          (who answers when no name is heard)
- follow-up seconds: 60              (no name within this time after an answer: whoever answered goes on)
- talk window seconds: 40            (after an answer you may talk without a name this long)
- silence ms: 1800                   (this much quiet ends a question)
- max question seconds: 60           (a question is cut off after this)
- grace seconds: 12                  (what you say right after a question is your own addition, not the TV)
- tv words: 60                       (a sentence this long without a name is the TV or a video: ignored)
- follow-up words: 25                (in name mode a follow-up without a name is at most this long ...)
- follow-up runs: 2                  (... and at most this many in a row)

## Noise
What speech-to-text makes of a sound or silence. A sentence that is only one of these is ignored. Anything in
[brackets], (round brackets) or *stars* is a sound description and is dropped too.
- thank you
- thanks for watching
- thank you for watching
- you
- bye
- bye bye
- okay
- ok
- so
- uh
- um
- hmm
- mm
- oh
- ah
- the
- i
- it
- and
- subscribe
- please subscribe
- music
- applause
- laughter
- silence
- beep
- click
- im sorry
- sorry
- thanks
- thank you very much
- terima kasih
- thank you so much
- see you
- see you next time
- goodbye

## One word that counts
A sentence of one word is ignored, unless it is one of these (or a number, or the answer to "your code, please").
- jev
- jeff
- jarvis
- ultron
- vision
- ghost
- yes
- yeah
- yep
- no
- nope
- stop
- more
- wait
- hello
- hi
- hey
- lock
- unlock
- lockdown
- louder
- quieter
- softer

## Additions
While it is still thinking, a sentence that starts like this is added to the question you asked (not a new question).
- more
- also
- and also
- wait
- oh and
- plus
- add
- one more

Short add-ons (at most 12 words) that start like this are added too:
- in
- for
- at
- and
- but
- with
- without
- about
- please
- to
- on
- near
- tomorrow
- today
- tonight
- only
- not
- make it
- i mean
- sorry

## Kind of question
Words that send a question straight to a branch (the character's own router decides everything else).
### weather
(Jev has a weather branch; the others look it up on the web.)
- weather
- temperature
- forecast
- rain
- raining
- snow
- sunny
- how cold
- how warm
- umbrella
- jacket
### web
- look up
- look it up
- search
- google
- news
- latest
- who won
- score
- price of
- stock
- what happened
- today's
- this week
- current
