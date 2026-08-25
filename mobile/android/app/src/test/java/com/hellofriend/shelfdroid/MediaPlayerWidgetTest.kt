package com.hellofriend.shelfdroid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MediaPlayerWidgetTest {
    @Test
    fun widgetButtonsTargetTheExistingPlayerService() {
        assertEquals(PlayerCommand.PLAY_PAUSE, MediaPlayerWidget.commandFor(ACTION_PLAY_PAUSE))
        assertEquals(PlayerCommand.JUMP_BACK, MediaPlayerWidget.commandFor(ACTION_BACK))
        assertEquals(PlayerCommand.JUMP_FORWARD, MediaPlayerWidget.commandFor(ACTION_FORWARD))
    }

    @Test
    fun unknownOrNullActionMapsToNoCommand() {
        assertNull(MediaPlayerWidget.commandFor("com.hellofriend.shelfdroid.widget.ACTION_UNKNOWN"))
        assertNull(MediaPlayerWidget.commandFor(null))
    }
}
