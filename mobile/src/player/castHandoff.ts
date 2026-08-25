import type { AbsAudioPlayerPlugin } from '../native/absAudioPlayerPlugin'
import type { CastDisconnectedEvent, CastPlugin } from '../native/castPlugin'

/** What `connectCast` needs to build a `CastLoadOptions` payload -- supplied by `PlayerProvider`
 * from the SAME session it already loaded into the native player (never re-resolved here, and
 * never a second `AbsClient.startSession` call -- see this module's class doc). `null` means
 * "nothing is currently loaded", in which case `connectCast` is a no-op. */
export interface CastSessionSource {
  contentUrl: string
  contentType: string
  title: string
  accessToken: string
}

export interface CastHandoffController {
  /** Pauses native playback, loads the current stream into Cast at the native player's last
   * known position/rate, and keeps casting until the receiver disconnects. No-op if
   * `getSource()` returns `null` (nothing loaded to hand off). */
  connectCast(): Promise<void>
  isCasting(): boolean
}

/**
 * Preserves ONE ABS playback session across native ExoPlayer <-> Chromecast (WI-1496 t900
 * Task 3), adapted from the donor app's `CastManager` session-availability handoff
 * (`switchToPlayer`) to this repo's simpler "one active backend at a time" player model: rather
 * than swapping ExoPlayer `Player` implementations inside a shared `PlayerNotificationService`
 * (the donor's `CastPlayer`/media3-style approach), this controller pauses the native player,
 * hands the same already-resolved stream URL + access token to the Cast receiver, and on
 * disconnect seeks the native player back to the last Cast-reported position and resumes it --
 * the ABS session id itself, and therefore progress-sync ownership (`nativeProgressSync.ts`),
 * never changes hands.
 */
export function createCastHandoffController(
  native: AbsAudioPlayerPlugin,
  cast: CastPlugin,
  getSource: () => CastSessionSource | null
): CastHandoffController {
  let casting = false

  void cast.addListener('disconnected', (event: CastDisconnectedEvent) => {
    casting = false
    void native.seek({ seconds: event.currentTime }).then(() => native.play())
  })

  return {
    isCasting(): boolean {
      return casting
    },

    async connectCast(): Promise<void> {
      const source = getSource()
      if (!source) return

      const snapshot = await native.getState()

      await native.pause()
      await cast.load({
        contentUrl: source.contentUrl,
        contentType: source.contentType,
        title: source.title,
        accessToken: source.accessToken,
        startTime: snapshot.currentTime,
        rate: snapshot.rate
      })
      casting = true
    }
  }
}
