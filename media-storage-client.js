/**
 * MediaStorage Client Library
 * Simple SDK to upload, download, and manage files
 */

class MediaStorage {
  constructor(baseURL = 'http://localhost:5000') {
    this.baseURL = baseURL;
  }

  /**
   * Upload a file to storage
   * @param {File} file - The file to upload
   * @returns {Promise<Object>} - File metadata including id and url
   */
  async uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`${this.baseURL}/upload`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const data = await response.json();
      return data.file;
    } catch (error) {
      console.error('Upload error:', error);
      throw error;
    }
  }

  /**
   * Download a file by filename
   * @param {string} filename - The filename to download
   * @returns {Promise<Blob>} - The file blob
   */
  async downloadFile(filename) {
    try {
      const response = await fetch(`${this.baseURL}/download/${filename}`);

      if (!response.ok) {
        throw new Error(`Download failed: ${response.statusText}`);
      }

      return await response.blob();
    } catch (error) {
      console.error('Download error:', error);
      throw error;
    }
  }

  /**
   * Get all files metadata
   * @returns {Promise<Array>} - Array of file objects
   */
  async listFiles() {
    try {
      const response = await fetch(`${this.baseURL}/files`);

      if (!response.ok) {
        throw new Error(`Failed to fetch files: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('List files error:', error);
      throw error;
    }
  }

  /**
   * Get metadata for a specific file
   * @param {string} fileId - The file ID
   * @returns {Promise<Object>} - File metadata
   */
  async getFile(fileId) {
    try {
      const response = await fetch(`${this.baseURL}/files/${fileId}`);

      if (!response.ok) {
        throw new Error(`File not found: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Get file error:', error);
      throw error;
    }
  }

  /**
   * Delete a file by ID
   * @param {string} fileId - The file ID to delete
   * @returns {Promise<Object>} - Success response
   */
  async deleteFile(fileId) {
    try {
      const response = await fetch(`${this.baseURL}/delete/${fileId}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(`Delete failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Delete error:', error);
      throw error;
    }
  }

  /**
   * Delete all files
   * @returns {Promise<Object>} - Success response
   */
  async deleteAllFiles() {
    try {
      const response = await fetch(`${this.baseURL}/files`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(`Delete all failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Delete all error:', error);
      throw error;
    }
  }
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MediaStorage;
}
