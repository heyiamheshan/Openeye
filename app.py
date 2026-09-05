"""Root entry point for the OpenEye Flask application.

This launcher imports the configured Flask application from the backend
package and starts the development server on port 5001.  It is used both
for local development and as the container entry point.
"""

from backend.app import app

if __name__ == "__main__":
    # Run the Flask application on all interfaces so it is reachable from
    # Docker and other machines on the network.  Threading lets multiple
    # clients view the MJPEG feed at the same time.
    app.run(host="0.0.0.0", port=5001, debug=False, threaded=True)
