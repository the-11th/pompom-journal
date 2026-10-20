package com.todopup.usage
import org.junit.Assert.*
import org.junit.Test
class PhotoInputTest {
    @Test fun originalReadFallsBackOnlyWhenProviderCannotExposeOriginal() {
        val original = byteArrayOf(1, 2, 3)
        assertArrayEquals(original, PhotoInput.readOriginal({ original.inputStream() }, { error("Redacted copy opened") }, 10))
        assertArrayEquals(original, PhotoInput.readOriginal({ throw SecurityException("Denied") }, { original.inputStream() }, 10))
        assertArrayEquals(original, PhotoInput.readOriginal({ throw UnsupportedOperationException() }, { original.inputStream() }, 10))
        assertThrows(IllegalArgumentException::class.java) {
            PhotoInput.readOriginal({ original.inputStream() }, { error("Must not fall back after a size error") }, 2)
        }
    }
    @Test fun exactLimitIsAcceptedAndOriginalBytesStayExact() {
        val original = ByteArray(9000) { (it % 251).toByte() }
        assertArrayEquals(original, PhotoInput.read(original.inputStream(), original.size))
    }
    @Test fun oversizeInputStopsBeforeReadingItsWholeContents() {
        var bytesRead = 0
        val input = object : java.io.InputStream() {
            override fun read(): Int { bytesRead++; return 1 }
            override fun read(b: ByteArray, off: Int, len: Int): Int { bytesRead += len; b.fill(1, off, off + len); return len }
        }
        assertThrows(IllegalArgumentException::class.java) { PhotoInput.read(input, 9000) }
        assertEquals(9001, bytesRead)
    }
}
